const { insertProductFixture } = require('./product-fixture');
const { test, assert, pool, crypto, request, authenticateApplicationSession, authenticateIdentitySession } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const exportsService = require('../src/services/export.service');
const sessions = require('../src/services/export-sessions.service');
const { installGoldenEvidence } = require('./12-export-templates.cases');
const { schema, stored, homeDefinition } = require('../test/fixtures/export-source-support');
const { product } = require('../test/fixtures/magento-v1/contract');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateBatch } = require('../src/services/export-templates/evaluate');
const pre = (d) => ({ expectedRevision: d.revision, expectedDefinitionHash: d.definitionHash });
const apply = (p) => ({ expectedRevision: p.expectedRevision, expectedDefinitionHash: p.expectedDefinitionHash, preparationHash: p.preparationHash });
const command = (s) => ({ expectedRevision: s.configurationRevision, expectedAccessEpoch: 'owner' });
const opts = (actor) => ({ mutationContext: { actorUserId: actor.applicationUser.id } });
async function installSchema(category, modelVersion) {
  const s = schema(category, modelVersion);
  const row = (await pool.query(`INSERT INTO sku_schema_versions(category_code,version,marker,status,config_hash)
    SELECT $1,COALESCE(MAX(version),0)+1,$2,'archived','synthetic source support'
    FROM sku_schema_versions WHERE category_code=$1 RETURNING id,version`, [category, 'support-' + crypto.randomUUID()])).rows[0];
  Object.assign(s, row);
  for (const q of s.questions) {
    const saved = (await pool.query(`INSERT INTO sku_schema_questions(schema_version_id,question_key,label,sku_index,required,sku_separator)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [s.id, q.key, q.label, q.sku_index, q.required, q.sku_separator])).rows[0];
    for (const o of q.options) await pool.query(`INSERT INTO sku_schema_options(schema_question_id,value_id,sku_code,label)
      VALUES($1,$2,$3,$4)`, [saved.id, o.value_id, o.sku_code, o.label]);
  }
  return s;
}
async function insert(p) {
  return (await insertProductFixture(pool,`INSERT INTO products(full_sku,base_sku,category,weight,total_price_uah,details,sku_schema_version_id)
    VALUES($1,$1,$2,$3,$4,$5::jsonb,$6) RETURNING *`, [p.full_sku, p.category, p.weight, p.total_price_uah, JSON.stringify(p.details), p.sku_schema_version_id ?? null])).rows[0];
}
async function effects(ids) {
  return {
    snapshots: (await pool.query('SELECT id FROM export_snapshots ORDER BY id')).rows,
    artifacts: (await pool.query('SELECT snapshot_id,group_code,csv_content FROM magento_export_artifacts ORDER BY snapshot_id,group_code')).rows,
    revisions: (await pool.query('SELECT * FROM product_export_revisions WHERE product_id=ANY($1::int[]) ORDER BY product_id', [ids])).rows,
    cursor: (await pool.query('SELECT * FROM export_state')).rows,
    links: (await pool.query('SELECT id,snapshot_id FROM export_sessions ORDER BY id')).rows,
    events: (await pool.query("SELECT id FROM audit_events WHERE event_key IN ('export_snapshot.created','export_session.generated') ORDER BY id")).rows,
  };
}

test('SUPPORT HTTP existing HOME-v2 draft: detached prepare/CAS/audit, full validation/publication, authoritative previews and direct/session captures', async () => {
  const actor = await authenticateApplicationSession(); const options = opts(actor);
  await installGoldenEvidence();
  const countBefore = (await pool.query('SELECT count(*) FROM export_templates')).rows[0].count;
  const candidate = await request('/api/admin/export-templates/candidate?supportPolicy=historical-source-support-v1', { authentication: actor });
  assert.equal(candidate.response.status, 200, candidate.text);
  assert.equal(candidate.data.definition.evaluatorVersion, 'magento-declarative-2');
  const current = await request('/api/admin/export-templates/candidate', { authentication: actor });
  assert.deepEqual(current.data, candidate.data, 'new current candidates require no explicit policy flag');
  const system = await request('/api/admin/export-templates/system', { authentication: actor });
  assert.equal(system.data.definition.sourceSupport, undefined);
  assert.equal(system.data.definition.evaluatorVersion, 'magento-declarative-1');
  assert.equal((await pool.query('SELECT count(*) FROM export_templates')).rows[0].count, countBefore);
  assert.equal((await request('/api/admin/export-templates/candidate?supportPolicy=unknown', { authentication: actor })).response.status, 400);
  const original = homeDefinition();
  // Existing approved mappings and significant whitespace are never part of repair.
  Object.assign(original.tables.arSize, { 29: '75×78', 30: '74×80', 31: ' 70×70\n ' });
  const f = await templates.createTemplate({ key: 'support-' + crypto.randomUUID(), displayName: 'Synthetic HOME columns', definition: original }, options);
  const endpoint = `/api/admin/export-templates/${f.id}/draft/source-support`;
  const before = await templates.getTemplate(f.id);
  const prepared = await request(endpoint + '/prepare', { method: 'POST', authentication: actor, body: pre(f.draft) });
  assert.equal(prepared.response.status, 200, prepared.text);
  assert.deepEqual(await templates.getTemplate(f.id), before);
  const repeated = await templates.prepareSourceSupport(f.id, pre(f.draft));
  assert.deepEqual(repeated, prepared.data);
  assert.deepEqual(repeated.definition.groups, original.groups);
  assert.deepEqual(repeated.definition.tables, original.tables);
  const applied = await request(endpoint + '/apply', { method: 'POST', authentication: actor, body: apply(repeated) });
  assert.equal(applied.response.status, 200, applied.text);
  const draft = applied.data;
  assert.equal(draft.revision, '2');
  assert.equal(draft.definition.outputContract, 'magento-products-columns-v2');
  assert.equal(draft.definitionHash, compileDefinition(draft.definition).hash);
  assert.equal((await templates.validateDraft(f.id, pre(draft))).valid, true);
  await assert.rejects(templates.applySourceSupport(f.id, apply(repeated), options), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  const noOp = await templates.prepareSourceSupport(f.id, pre(draft));
  assert.equal(noOp.changed, false);
  assert.equal((await templates.applySourceSupport(f.id, apply(noOp), options)).revision, draft.revision);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE subject_id=$1 AND event_key='export_template.draft_updated'", [f.id])).rows[0].n, 1);
  const v = await templates.publishTemplate(f.id, pre(draft), options);
  const nm = await installSchema('NM', 1); const ar = await installSchema('AR', 2);
  const products = [await insert(stored(nm, 0)), await insert(stored(ar, 28)), await insert(product('BR', { color: 4 }, { full_sku: 'BR-SUPPORT-' + crypto.randomUUID().toUpperCase() }))];
  const sample = await templates.testPreview(f.id, { ...pre(draft), productIds: products.map((p) => p.id) });
  assert.equal(sample.result.status, 'ready');
  const expectedBR = evaluateBatch(compileDefinition(original), [products[2]]).artifacts[0].csvContent;
  assert.equal(sample.result.artifacts.find((a) => a.groupCode === 'BR').csvContent, expectedBR);
  const input = { requestContract: 'template-v1', fromSku: products[0].full_sku, toSku: products[2].full_sku,
    selection: { mode: 'explicit', templateId: f.id, versionId: v.id } };
  const preview = await exportsService.previewExport(input, options);
  assert.equal(preview.readyCount, 3); assert.ok(preview.previewToken);
  const key = crypto.randomUUID();
  const capture = await exportsService.createExportSnapshot({ ...input, previewToken: preview.previewToken, idempotencyKey: key }, options);
  const artifacts = await exportsService.getMagentoArtifacts(capture.id, { ...options, includeRows: true });
  assert.equal(artifacts.find((a) => a.groupCode === 'BR').csvContent, expectedBR);
  const s = await sessions.createSession({ creationKey: crypto.randomUUID(), title: 'Synthetic support session', settings: input }, options);
  const member = await authenticateIdentitySession({ subject: 'support-member-' + crypto.randomUUID() });
  const roleId = (await pool.query("SELECT id FROM roles WHERE role_key='administrator'")).rows[0].id;
  const approved = await request(`/api/admin/users/${member.applicationUser.id}/approve`, { authentication: actor, method: 'POST', body: { roleId } });
  assert.equal(approved.response.status, 200, approved.text);
  const invitation = await sessions.invite(s.id, { userId: member.applicationUser.id, expectedAccessEpoch: 'owner' }, options);
  const accepted = await sessions.membership(s.id, { action: 'accept', expectedAccessEpoch: invitation.epoch }, opts(member));
  const memberCommand = { expectedRevision: s.configurationRevision, expectedAccessEpoch: accepted.epoch };
  const sessionPreview = await sessions.previewSession(s.id, options);
  assert.equal(sessionPreview.readyCount, 3);
  const attempt = await sessions.prepare(s.id, memberCommand, opts(member));
  const sessionCapture = await sessions.generate(s.id, { ...memberCommand, attemptId: attempt.id }, opts(member));
  assert.ok(sessionCapture.snapshotId || sessionCapture.id);
  // Completed retries and downloads are stored evidence, even when live answers cease to be valid.
  await pool.query("UPDATE products SET details=jsonb_set(details,'{answers,extra}','9') WHERE id=$1", [products[0].id]);
  assert.equal((await exportsService.createExportSnapshot({ ...input, previewToken: preview.previewToken, idempotencyKey: key }, options)).id, capture.id);
  assert.deepEqual(await exportsService.getMagentoArtifacts(capture.id, { ...options, includeRows: true }), artifacts);
  assert.equal((await sessions.generate(s.id, { ...command(s), attemptId: attempt.id }, options)).id, sessionCapture.id);
});

test('SUPPORT lifecycle current candidate/system-copy drafts start current; catalog drift cannot offer a no-op upgrade', async () => {
  const actor = await authenticateApplicationSession(); const options = opts(actor);
  await installGoldenEvidence();
  const root = '/api/admin/export-templates';
  const candidate = await request(root + '/candidate', { authentication: actor });
  assert.equal(candidate.response.status, 200, candidate.text);
  assert.deepEqual(candidate.data.diagnostics, []);
  assert.equal(candidate.data.definition.sourceSupport.version, 'historical-source-support-v1');
  assert.equal(candidate.data.definitionHash, compileDefinition(candidate.data.definition).hash);
  const system = await request(root + '/system', { authentication: actor });
  assert.equal(system.data.definition.sourceSupport, undefined, 'ordinary profile is not relabelled');
  for (const boundary of ['new-current', 'current-system-copy']) {
    // Both explicit client creation paths request the authoritative current candidate.
    const created = await request(root, { authentication: actor, method: 'POST', body: {
      key: boundary + '-' + crypto.randomUUID(), displayName: boundary, definition: candidate.data.definition,
    } });
    assert.equal(created.response.status, 201, created.text);
    const f = created.data; const before = await templates.getTemplate(f.id);
    assert.equal(f.draft.sourceSupportUpdate.status, 'current');
    assert.deepEqual(f.draft.definition, candidate.data.definition);
    assert.equal((await templates.validateDraft(f.id, pre(f.draft))).valid, true);
    const proposal = await templates.prepareSourceSupport(f.id, pre(f.draft));
    assert.equal(proposal.changed, false); assert.equal(proposal.sourceSupportUpdate.status, 'current');
    assert.deepEqual(await templates.getTemplate(f.id), before, 'reads/preparation/validation never rewrite');
    assert.deepEqual(await templates.applySourceSupport(f.id, apply(proposal), options), before.draft, 'old no-op callers retain revision/actor/time');
    const q = (await pool.query("SELECT id,label FROM questions WHERE category_code='BR' AND key='color'")).rows[0];
    await pool.query('UPDATE questions SET label=$2 WHERE id=$1', [q.id, 'Synthetic renamed characteristic']);
    const option = (await pool.query(`INSERT INTO options(question_id,value_id,sku_code,label,archived)
      VALUES($1,999999,'999999','Synthetic later option',false) RETURNING id`, [q.id])).rows[0];
    try {
      const afterCatalog = await templates.prepareSourceSupport(f.id, pre(f.draft));
      assert.equal(afterCatalog.changed, false);
      assert.equal(afterCatalog.sourceSupportUpdate.status, 'current');
      assert.equal(afterCatalog.definitionHash, f.draft.definitionHash);
      assert.deepEqual(afterCatalog.definition, f.draft.definition);
      assert.deepEqual(await templates.getTemplate(f.id), before);
    } finally {
      await pool.query('DELETE FROM options WHERE id=$1', [option.id]);
      await pool.query('UPDATE questions SET label=$2 WHERE id=$1', [q.id, q.label]);
    }
  }
});

test('SUPPORT lifecycle old/current publication clones stay exact; explicit draft upgrade alone changes support metadata', async () => {
  const actor = await authenticateApplicationSession(); const options = opts(actor);
  await installGoldenEvidence();
  const original = homeDefinition();
  // Publishable historical membership; the separately tested deferred mappings remain stored.
  const { catalog } = require('../test/fixtures/magento-v1/contract');
  const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
  original.questionContracts['AR.size'].allowed = materializeMagentoV1(catalog()).questionContracts['AR.size'].allowed;
  original.tables.localColor = { ...original.tables.color4, 4: '  Custom frozen color\n ' };
  original.groups[0].rows[0].cells.test_export_color.table = 'localColor';
  original.groups[0].rows[1].cells.test_export_note = { op: 'literal', value: 'Independent EN' };
  const f = await templates.createTemplate({ key: 'clone-policy-' + crypto.randomUUID(), displayName: 'Synthetic legacy publication', definition: original }, options);
  assert.equal(f.draft.sourceSupportUpdate.status, 'available');
  assert.deepEqual(await templates.saveDraft(f.id, { expectedRevision: f.draft.revision, definition: original }, options), f.draft);
  const oldVersion = await templates.publishTemplate(f.id, pre(f.draft), options);
  assert.deepEqual(oldVersion.definition, original);
  const modified = structuredClone(original); modified.tables.localColor['4'] = 'Unrelated draft work';
  const edited = await templates.saveDraft(f.id, { expectedRevision: f.draft.revision, definition: modified }, options);
  const clone = await templates.cloneDraft(f.id, { expectedRevision: edited.revision, versionId: oldVersion.id }, options);
  assert.deepEqual(clone.definition, original);
  assert.equal(clone.definitionHash, oldVersion.definitionHash);
  assert.equal(clone.baseVersionId, oldVersion.id);
  assert.equal(clone.sourceSupportUpdate.status, 'available');
  const before = await templates.getTemplate(f.id);
  const proposal = await templates.prepareSourceSupport(f.id, pre(clone));
  assert.equal(proposal.changed, true); assert.equal(proposal.sourceSupportUpdate.status, 'available');
  assert.deepEqual(await templates.getTemplate(f.id), before);
  const upgraded = await templates.applySourceSupport(f.id, apply(proposal), options);
  assert.equal(upgraded.sourceSupportUpdate.status, 'current');
  assert.equal(upgraded.revision, String(BigInt(clone.revision) + 1n));
  const restored = structuredClone(upgraded.definition);
  delete restored.sourceSupport; restored.evaluatorVersion = original.evaluatorVersion;
  assert.deepEqual(restored, original, 'all columns/order/mappings/Main/EN/contracts/bindings/readiness remain exact');
  assert.notEqual(upgraded.definitionHash, clone.definitionHash);
  assert.deepEqual(evaluateBatch(compileDefinition(upgraded.definition), [product('BR', { color: 4 })]),
    evaluateBatch(compileDefinition(original), [product('BR', { color: 4 })]));
  const noOp = await templates.prepareSourceSupport(f.id, pre(upgraded));
  assert.equal(noOp.changed, false); assert.equal(noOp.sourceSupportUpdate.status, 'current');
  const currentVersion = await templates.publishTemplate(f.id, pre(upgraded), options);
  const currentClone = await templates.cloneDraft(f.id, { expectedRevision: upgraded.revision, versionId: currentVersion.id }, options);
  assert.deepEqual(currentClone.definition, currentVersion.definition);
  assert.equal(currentClone.definitionHash, currentVersion.definitionHash);
  assert.equal(currentClone.sourceSupportUpdate.status, 'current');
  assert.equal((await templates.prepareSourceSupport(f.id, pre(currentClone))).changed, false);
  await assert.rejects(pool.query('UPDATE export_template_versions SET definition=definition WHERE id=$1', [oldVersion.id]), /immutable/);
  const versions = (await templates.getTemplate(f.id)).versions;
  assert.deepEqual(versions, [oldVersion, currentVersion]);
  const future = structuredClone(currentClone.definition); future.sourceSupport.version = 'future-policy';
  const unknown = await templates.saveDraft(f.id, { expectedRevision: currentClone.revision, definition: future }, options);
  assert.equal(unknown.sourceSupportUpdate.status, 'unsupported');
  const unknownBefore = await templates.getTemplate(f.id);
  assert.deepEqual(unknownBefore.draft.definition, future);
  await assert.rejects(templates.prepareSourceSupport(f.id, pre(unknown)), { code: 'TEMPLATE_INVALID' });
  await assert.rejects(templates.applySourceSupport(f.id, { ...pre(unknown), preparationHash: proposal.preparationHash }, options), { code: 'TEMPLATE_INVALID' });
  await assert.rejects(templates.publishTemplate(f.id, pre(unknown), options), { code: 'TEMPLATE_INVALID' });
  assert.deepEqual(await templates.getTemplate(f.id), unknownBefore);
});

test('SUPPORT stale evidence/permission changes conflict; invalid represented products roll back whole direct/session capture', async () => {
  const actor = await authenticateApplicationSession(); const options = opts(actor);
  await installGoldenEvidence();
  const f = await templates.createTemplate({ key: 'support-stale-' + crypto.randomUUID(), displayName: 'Synthetic stale support', definition: homeDefinition() }, options);
  const p = await templates.prepareSourceSupport(f.id, pre(f.draft));
  const extraSchema = await installSchema('AR', 2);
  await assert.rejects(templates.applySourceSupport(f.id, apply(p), options), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  assert.equal((await templates.getTemplate(f.id)).draft.revision, '1');
  const current = await templates.prepareSourceSupport(f.id, pre(f.draft));
  const draft = await templates.applySourceSupport(f.id, apply(current), options);
  await assert.rejects(templates.saveDraft(f.id, { expectedRevision: '1', definition: f.draft.definition }, options), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  const v = await templates.publishTemplate(f.id, pre(draft), options);
  const ar = await insert(stored(extraSchema, 28));
  const br = await insert(product('BR', {}, { full_sku: 'BR-ATOMIC-' + crypto.randomUUID().toUpperCase() }));
  const input = { requestContract: 'template-v1', fromSku: ar.full_sku, toSku: br.full_sku, selection: { mode: 'explicit', templateId: f.id, versionId: v.id } };
  const preview = await exportsService.previewExport(input, options);
  const s = await sessions.createSession({ creationKey: crypto.randomUUID(), title: 'Must remain atomic', settings: input }, options);
  const attempt = await sessions.prepare(s.id, command(s), options);
  const before = await effects([ar.id, br.id]);
  await pool.query("UPDATE products SET details=jsonb_set(details,'{answers,size}','29') WHERE id=$1", [ar.id]);
  const invalid = await exportsService.previewExport(input, options);
  assert.equal(invalid.readyCount, 1); assert.equal(invalid.representedCount, 2); assert.equal(invalid.previewToken, null);
  assert.ok(invalid.errors[0].fields.some((e) => e.code === 'SOURCE_SUPPORT_INVALID'));
  await assert.rejects(exportsService.createExportSnapshot({ ...input, previewToken: preview.previewToken, idempotencyKey: crypto.randomUUID() }, options), { code: 'EXPORT_PREVIEW_STALE' });
  await assert.rejects(sessions.generate(s.id, { ...command(s), attemptId: attempt.id }, options));
  assert.deepEqual(await effects([ar.id, br.id]), before);
  const fresh = await sessions.createSession({ creationKey: crypto.randomUUID(), title: 'Invalid prepare', settings: input }, options);
  assert.equal((await sessions.prepare(fresh.id, command(fresh), options)).state, 'not-ready');
  assert.equal((await pool.query('SELECT count(*)::int n FROM export_session_attempts WHERE session_id=$1', [fresh.id])).rows[0].n, 0);
  await pool.query("UPDATE products SET details=jsonb_set(details,'{answers,size}','28') WHERE id=$1", [ar.id]);
  const valid = await exportsService.previewExport(input, options);
  // Immutable historical additions change the bound reference evidence, but cannot promote this frozen policy.
  const future = await installSchema('AR', 3);
  await assert.rejects(exportsService.createExportSnapshot({ ...input, previewToken: valid.previewToken, idempotencyKey: crypto.randomUUID() }, options), { code: 'EXPORT_PREVIEW_STALE' });
  for (const value of [29, 30, 31]) {
    const item = await insert(stored(future, value));
    const result = await templates.testPreview(f.id, { ...pre(draft), productIds: [item.id] });
    assert.equal(result.result.failedCount, 1);
  }
  const user = await authenticateIdentitySession({ subject: 'support-manager-' + crypto.randomUUID() });
  const role = await request('/api/admin/roles', { authentication: actor, method: 'POST', body: { displayName: 'Support manager ' + crypto.randomUUID(), description: 'Disposable support test', permissionKeys: ['export_templates.view', 'export_templates.manage'] } });
  assert.equal(role.response.status, 201, role.text);
  await request(`/api/admin/users/${user.applicationUser.id}/approve`, { authentication: actor, method: 'POST', body: { roleId: role.data.role.id } });
  const prepared = await request(`/api/admin/export-templates/${f.id}/draft/source-support/prepare`, { authentication: user, method: 'POST', body: pre(draft) });
  assert.equal(prepared.response.status, 200, prepared.text);
  await pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='export_templates.manage'", [role.data.role.id]);
  const denied = await request(`/api/admin/export-templates/${f.id}/draft/source-support/apply`, { authentication: user, method: 'POST', body: apply(prepared.data) });
  assert.equal(denied.response.status, 403);
  await assert.rejects(templates.applySourceSupport(f.id, apply(prepared.data), opts(user)), { code: 'ADMIN_PERMISSION_REVOKED' });
  assert.equal((await templates.getTemplate(f.id)).draft.revision, draft.revision);
});
