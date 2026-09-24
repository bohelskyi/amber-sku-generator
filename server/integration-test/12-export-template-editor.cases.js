const { assert, test, pool, crypto, request, authenticateApplicationSession, authenticateIdentitySession } = require('./suite-context');
const { installGoldenEvidence, definition } = require('./12-export-templates.cases');
const { catalog, product } = require('../test/fixtures/magento-v1/contract');
const { compileDefinition, hashJsonData } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const root = '/api/admin/export-templates';

async function state() {
  const result = {};
  for (const table of ['products', 'questions', 'options', 'sku_schema_versions', 'sku_schema_questions', 'sku_schema_options',
    'export_templates', 'export_template_drafts', 'export_template_versions', 'export_template_activation',
    'export_snapshots', 'magento_export_artifacts', 'product_export_revisions', 'export_state']) {
    result[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]') AS data FROM ${table} t`)).rows[0].data;
  }
  return result;
}

test('OFFICE valid-name unresolved draft creates, saves and reopens; publication remains blocked without repairs', async () => {
  const admin = await authenticateApplicationSession();
  // Sample scope now follows the stored category; use an explicit blocked NM fixture.
  const sample = product('NM');
  const sampleId = (await pool.query(`INSERT INTO products (full_sku,base_sku,category,weight,total_price_uah,details)
    VALUES ($1,$1,'NM',$2,$3,$4::jsonb) RETURNING id`, [`NM-OFFICE-${crypto.randomUUID()}`.toUpperCase(), sample.weight, sample.total_price_uah, JSON.stringify(sample.details)])).rows[0].id;
  const before = await state();
  const candidate = await request(`${root}/candidate`, { authentication: admin });
  assert.equal(candidate.response.status, 200, candidate.text);
  assert.deepEqual(await state(), before);
  // Remain genuinely unresolved even after other serialized tests add golden evidence.
  const d = structuredClone(candidate.data.definition);
  d.sources['NM.extra'].key = 'office_unknown_extra';
  compileDefinition(d);
  const key = `office-${crypto.randomUUID()}`;
  const create = (displayName, definition = d) => request(root, { method: 'POST', authentication: admin,
    body: { key, displayName, definition } });
  const empty = await create('');
  assert.equal(empty.response.status, 400); assert.equal(empty.data.code, 'TEMPLATE_COMMAND_INVALID');
  for (const unsafe of [null, [], { value: '\u0000' }, JSON.parse('{"__proto__":{}}'), { value: 'x'.repeat(4097) }]) {
    const rejected = await create('Office template regression', unsafe);
    assert.equal(rejected.response.status, 422); assert.equal(rejected.data.code, 'TEMPLATE_INVALID');
  }
  assert.deepEqual(await state(), before);
  const created = await create('Office template regression');
  assert.equal(created.response.status, 201, created.text);
  const id = created.data.id;
  const noOpState = await state();
  const noOp = await request(`${root}/${id}/draft`, { method: 'PUT', authentication: admin,
    body: { expectedRevision: '1', definition: d } });
  assert.equal(noOp.response.status, 200); assert.equal(noOp.data.revision, '1');
  assert.deepEqual(await state(), noOpState);
  d.groups[0].rows[0].cells.meta_title = { op: 'literal', value: 'Office edit' };
  const save = await request(`${root}/${id}/draft`, { method: 'PUT', authentication: admin,
    body: { expectedRevision: '1', definition: d } });
  assert.equal(save.response.status, 200); assert.equal(save.data.revision, '2');
  const reopened = await request(`${root}/${id}`, { authentication: admin });
  assert.deepEqual(reopened.data.draft.definition, d); assert.equal(reopened.data.draft.state, 'draft');
  assert.deepEqual(reopened.data.versions, []);
  const beforeValidation = await state();
  for (const action of ['validate', 'publish', 'test-preview']) {
    const result = await request(`${root}/${id}/${action}`, { method: 'POST', authentication: admin,
      body: { expectedRevision: '2', expectedDefinitionHash: save.data.definitionHash,
        ...(action === 'test-preview' ? { productIds: [sampleId] } : {}) } });
    assert.equal(result.response.status, 422, result.text); assert.equal(result.data.code, 'TEMPLATE_SOURCE_INVALID');
    assert.ok(result.data.details.diagnostics.some((v) => v.sourceId === 'NM.extra'));
  }
  assert.deepEqual(await state(), beforeValidation, 'validation/publication failure never repairs or exports');
  for (const table of Object.keys(before).filter((name) => !['export_templates', 'export_template_drafts'].includes(name))) {
    assert.deepEqual(beforeValidation[table], before[table], table);
  }
});

// Only this serialized disposable fixture supplies synthetic catalog evidence.
// The application adapter never imports test defaults or repairs the catalog.
async function installCandidateCatalog() {
  await installGoldenEvidence();
  for (const [group, questions] of catalog()) {
    for (const [key, question] of questions) {
      let rows = (await pool.query('SELECT id FROM questions WHERE category_code=$1 AND key=$2', [group, key])).rows;
      assert.ok(rows.length <= 1);
      if (!rows.length) rows = (await pool.query(`INSERT INTO questions
        (category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
        VALUES ($1,$2,'PR4 synthetic current question',0,999,0,0,'options') RETURNING id`, [group, key])).rows;
      const id = rows[0].id;
      await pool.query('UPDATE questions SET required=$2,visible_if_json=$3 WHERE id=$1', [id, question.required, question.visible_if_json]);
      for (const option of question.options) {
        await pool.query(`INSERT INTO options (question_id,value_id,sku_code,label,archived)
          SELECT $1,$2,$3,'PR4 synthetic option',false WHERE NOT EXISTS
          (SELECT 1 FROM options WHERE question_id=$1 AND value_id=$2)`, [id, Number(option.value_id), String(option.value_id)]);
      }
    }
  }
}

test('PR4 candidate is read-only, diagnostic, protected; synthetic forms save/load/validate/publish/preview/store/download lifecycle', async () => {
  const admin = await authenticateApplicationSession();
  const before = await state();
  const initial = await request(`${root}/candidate`, { authentication: admin });
  assert.equal(initial.response.status, 200, initial.text);
  assert.equal(initial.data.candidateOnly, true);
  assert.equal(initial.data.productionAcceptanceVerified, false);
  assert.deepEqual(await state(), before, 'preparing candidate never persists, publishes or selects');
  assert.ok(initial.data.diagnostics.length > 0, 'incomplete current catalog is diagnosed, not repaired');

  await installCandidateCatalog();
  const candidate = await request(`${root}/candidate`, { authentication: admin });
  assert.equal(candidate.response.status, 200, candidate.text);
  assert.deepEqual(candidate.data.diagnostics, []);
  assert.equal(hashJsonData(candidate.data.definition), candidate.data.definitionHash);
  const f = await request(root, { method: 'POST', authentication: admin, body: {
    key: `pr4-${crypto.randomUUID()}`, displayName: 'PR4 form lifecycle', definition: candidate.data.definition,
  } });
  assert.equal(f.response.status, 201, f.text);
  const unchanged = await request(`${root}/${f.data.id}/draft`, { method: 'PUT', authentication: admin,
    body: { expectedRevision: f.data.draft.revision, definition: candidate.data.definition } });
  assert.equal(unchanged.data.revision, f.data.draft.revision);
  assert.equal(unchanged.data.definitionHash, candidate.data.definitionHash);
  const { replaceAt, moveItem } = await import('../../client/src/lib/export-template-editor.js');
  let edited = replaceAt(candidate.data.definition, ['groups', 0, 'rows', 0, 'cells', 'meta_title', 'value'], '  PR4 новий заголовок  ');
  edited = replaceAt(edited, ['tables', 'materialUa', '1'], 'особливого');
  const columns = edited.groups[0].columns;
  edited = replaceAt(edited, ['groups', 0, 'columns'], moveItem(columns, columns.indexOf('name'), -1));
  const save = await request(`${root}/${f.data.id}/draft`, { method: 'PUT', authentication: admin,
    body: { expectedRevision: unchanged.data.revision, definition: edited } });
  assert.equal(save.response.status, 200, save.text);
  const loaded = await request(`${root}/${f.data.id}`, { authentication: admin });
  assert.deepEqual(loaded.data.draft.definition, edited);
  assert.equal(loaded.data.draft.definitionHash, hashJsonData(edited));
  const expected = { expectedRevision: save.data.revision, expectedDefinitionHash: save.data.definitionHash };
  const valid = await request(`${root}/${f.data.id}/validate`, { method: 'POST', authentication: admin, body: expected });
  assert.equal(valid.response.status, 200, valid.text); assert.equal(valid.data.productionAcceptanceVerified, false);
  const p = product('BR');
  const stored = (await pool.query(`INSERT INTO products (full_sku,base_sku,category,weight,total_price_uah,details)
    VALUES ($1,$1,$2,$3,$4,$5::jsonb) RETURNING *`, [`BR-PR4-${crypto.randomUUID()}`.toUpperCase(), p.category, p.weight, p.total_price_uah, JSON.stringify(p.details)])).rows[0];
  const originalResult = evaluateProduct(compileDefinition(candidate.data.definition), stored);
  const editedResult = evaluateProduct(compileDefinition(edited), stored);
  assert.equal(editedResult.base.meta_title, '  PR4 новий заголовок  ');
  assert.equal(editedResult.base.name, `Браслет з особливого бурштину. Арт: ${stored.full_sku}`);
  for (const [key, value] of Object.entries(originalResult.base)) {
    if (!['name', 'meta_title'].includes(key)) assert.equal(editedResult.base[key], value, key);
  }
  assert.deepEqual(editedResult.english, originalResult.english);
  const beforePreview = await state();
  const draftPreview = await request(`${root}/${f.data.id}/test-preview`, { method: 'POST', authentication: admin, body: { ...expected, productIds: [stored.id] } });
  assert.equal(draftPreview.response.status, 200, draftPreview.text); assert.equal(draftPreview.data.draftOnly, true);
  assert.equal(draftPreview.data.previewToken, undefined); assert.deepEqual(await state(), beforePreview);
  const publication = await request(`${root}/${f.data.id}/publish`, { method: 'POST', authentication: admin, body: expected });
  assert.equal(publication.response.status, 200, publication.text);
  const intent = { requestContract: 'template-v1', fromSku: stored.full_sku, toSku: stored.full_sku,
    selection: { mode: 'explicit', templateId: f.data.id, versionId: publication.data.id } };
  const preview = await request('/api/export/preview', { method: 'POST', authentication: admin, body: intent });
  assert.equal(preview.response.status, 200, preview.text); assert.equal(preview.data.readyCount, 1);
  const snapshot = await request('/api/export/snapshots', { method: 'POST', authentication: admin,
    body: { ...intent, previewToken: preview.data.previewToken, idempotencyKey: crypto.randomUUID() } });
  assert.equal(snapshot.response.status, 201, snapshot.text);
  const download = await request(`/api/export/snapshots/${snapshot.data.id}/magento/BR/csv`, { authentication: admin });
  assert.equal(download.response.status, 200, download.text);
  assert.deepEqual(Buffer.from(download.text), Buffer.from(draftPreview.data.result.artifacts[0].csvContent));
  assert.equal((await pool.query('SELECT has_product_snapshot FROM product_export_revisions WHERE product_id=$1', [stored.id])).rows[0].has_product_snapshot, true);
  assert.equal((await pool.query('SELECT status FROM export_snapshots WHERE id=$1', [snapshot.data.id])).rows[0].status, 'generated', 'download does not confirm');
});

test('PR4 candidate requires both view and manage; revocation, pending, disabled and unauthenticated reads fail closed', async () => {
  const admin = await authenticateApplicationSession();
  const actor = await authenticateIdentitySession({ subject: `pr4-candidate-${crypto.randomUUID()}` });
  assert.equal((await request(`${root}/candidate`, { authentication: null })).response.status, 401);
  const pending = await request(`${root}/candidate`, { authentication: actor });
  assert.equal(pending.data.code, 'APP_ACCESS_PENDING');
  const created = await request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
    displayName: `PR4 candidate ${crypto.randomUUID()}`, description: 'Synthetic adapter permissions', permissionKeys: [],
  } });
  let role = created.data.role;
  const approved = await request(`/api/admin/users/${actor.applicationUser.id}/approve`, { authentication: admin, method: 'POST', body: { roleId: role.id } });
  assert.equal(approved.response.status, 200, approved.text);
  for (const [keys, status] of [[[], 403], [['export_templates.view'], 403], [['export_templates.manage'], 403],
    [['export_templates.view', 'export_templates.manage'], 200], [['export_templates.view'], 403]]) {
    const updated = await request(`/api/admin/roles/${role.id}/permissions`, { authentication: admin, method: 'PUT', body: {
      permissionKeys: keys, expectedVersion: role.version, expectedActiveAssignedUserCount: 1,
    } });
    assert.equal(updated.response.status, 200, updated.text); role = updated.data.role;
    assert.equal((await request(`${root}/candidate`, { authentication: actor })).response.status, status);
  }
  const templates = require('../src/services/export-templates/template.service');
  const options = { mutationContext: { actorUserId: admin.applicationUser.id, requestId: 'pr4-safe-metadata' } };
  const family = await templates.createTemplate({ key: `pr4-meta-${crypto.randomUUID()}`, displayName: 'Safe publication identity', definition: definition() }, options);
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
  const activation = await templates.getActivation();
  await templates.updateActivation({ expectedGeneration: activation.generation, implementation: 'template', templateVersionId: version.id }, options);
  for (const capabilities of [['exports.view'], ['exports.view', 'export_templates.activate']]) {
    const granted = await request(`/api/admin/roles/${role.id}/permissions`, { authentication: admin, method: 'PUT', body: {
      permissionKeys: capabilities, expectedVersion: role.version, expectedActiveAssignedUserCount: 1,
    } });
    assert.equal(granted.response.status, 200, granted.text); role = granted.data.role;
    const safe = await request('/api/export/template-options', { authentication: actor });
    assert.equal(safe.response.status, 200, safe.text);
    assert.equal(safe.data.defaultExporter, 'legacy');
    if (capabilities.length === 1) assert.deepEqual(safe.data.versions.map((v) => v.versionId), [version.id]);
    else assert.ok(safe.data.versions.length > 1);
    for (const item of safe.data.versions) assert.deepEqual(Object.keys(item).sort(), ['displayName', 'templateId', 'versionId', 'versionNumber']);
    assert.equal((await request(`${root}/sources`, { authentication: actor })).response.status, 403);
    assert.equal((await request(`${root}/${family.id}`, { authentication: actor })).response.status, 403);
  }
  assert.equal((await request('/api/export/template-options', { authentication: null })).response.status, 401);
  await pool.query("UPDATE application_users SET status='disabled' WHERE id=$1", [actor.applicationUser.id]);
  assert.equal((await request(`${root}/candidate`, { authentication: actor })).data.code, 'APP_ACCESS_DISABLED');
  assert.equal((await request('/api/export/template-options', { authentication: actor })).data.code, 'APP_ACCESS_DISABLED');
});
