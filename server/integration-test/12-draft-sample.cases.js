const { insertProductFixture } = require('./product-fixture');
const { assert, test, pool, crypto, request, authenticateApplicationSession, authenticateIdentitySession } = require('./suite-context');
const { officeCatalog } = require('../test/fixtures/magento-v1/office');
const { product } = require('../test/fixtures/magento-v1/contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const root = '/api/admin/export-templates';

async function state() {
  const result = {};
  for (const table of ['export_templates', 'export_template_drafts', 'export_template_versions', 'export_template_activation',
    'products', 'questions', 'options', 'sku_schema_versions', 'sku_schema_questions', 'sku_schema_options',
    'export_snapshots', 'magento_export_artifacts', 'price_export_snapshots', 'export_sessions', 'export_session_attempts',
    'export_session_members', 'audit_events', 'product_export_revisions', 'export_state']) {
    result[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]') AS data FROM ${table} t`)).rows[0].data;
  }
  return result;
}

test('Draft sample scopes source proof to stored BR products while same draft validation/publication stays strict', async () => {
  const admin = await authenticateApplicationSession();
  const pending = await authenticateIdentitySession({ subject: `sample-pending-${crypto.randomUUID()}` });
  const forbidden = await authenticateIdentitySession({ subject: `sample-forbidden-${crypto.randomUUID()}` });
  await pool.query("UPDATE application_users SET status='active' WHERE id=$1", [forbidden.applicationUser.id]);
  const d = materializeMagentoV1(officeCatalog());
  // All fixture writes are inside the canonical disposable harness. Install
  // historical semantic evidence without inventing NM zero or AR 29/30/31.
  for (const group of d.groups) {
    await pool.query('INSERT INTO categories (code,name,requires_weight) VALUES ($1,$2,0) ON CONFLICT (code) DO NOTHING', [group.route, group.name]);
    const schema = (await pool.query(`INSERT INTO sku_schema_versions
      (category_code,version,marker,status,config_hash)
      SELECT $1,COALESCE(MAX(version),0)+1,$2,'archived','synthetic sample evidence'
      FROM sku_schema_versions WHERE category_code=$1 RETURNING id`, [group.route, `sample-${crypto.randomUUID()}`])).rows[0];
    let index = 0;
    for (const [id, s] of Object.entries(d.sources).filter(([, s]) => s.category === group.route)) {
      if (s.kind === 'information') {
        if (id === 'KL.exact_size') continue;
        await pool.query(`INSERT INTO questions (category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
          SELECT $1,$2,'Sample information',0,999,0,0,'text'
          WHERE NOT EXISTS (SELECT 1 FROM questions WHERE category_code=$1 AND key=$2)`, [s.category, s.key]);
      } else {
        const q = (await pool.query(`INSERT INTO sku_schema_questions (schema_version_id,question_key,label,sku_index)
          VALUES ($1,$2,'Sample historical source',$3) RETURNING id`, [schema.id, s.key, ++index])).rows[0];
        const ids = (d.questionContracts[id]?.allowed || []).filter((value) => !(id === 'NM.extra' && value === '0')
          && !(id === 'AR.size' && ['29', '30', '31'].includes(value)));
        for (const value of ids) await pool.query(`INSERT INTO sku_schema_options (schema_question_id,value_id,sku_code,label,archived)
          VALUES ($1,$2,$3,'Synthetic semantic option',true)`, [q.id, Number(value), String(Number(value) + 900)]);
      }
    }
  }
  const original = compileDefinition(d);
  const name = d.bindings.find((b) => b.id === 'BR.nameUa').value.then;
  name.template = '[ТЕСТ] Браслет з {material} бурштину. Колір: {color}. Арт: {sku}';
  name.slots.color = { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: 'BR.color' } }, table: 'color4', otherwise: { op: 'literal', value: '' } };
  const created = await request(root, { method: 'POST', authentication: admin,
    body: { key: `sample-${crypto.randomUUID()}`, displayName: 'Synthetic saved sample', definition: d } });
  assert.equal(created.response.status, 201, created.text);
  const id = created.data.id;
  const precondition = { expectedRevision: created.data.draft.revision, expectedDefinitionHash: created.data.draft.definitionHash };
  const stored = {};
  for (const group of ['BR', 'NM', 'AR']) {
    const p = product(group);
    stored[group] = (await insertProductFixture(pool,`INSERT INTO products (full_sku,base_sku,category,weight,total_price_uah,details)
      VALUES ($1,$1,$2,$3,$4,$5::jsonb) RETURNING *`, [`${group}-SAMPLE-${crypto.randomUUID()}`.toUpperCase(), group, p.weight, p.total_price_uah, JSON.stringify(p.details)])).rows[0];
  }
  const command = (action, extra = {}, authentication = admin) => request(`${root}/${id}/${action}`,
    { method: 'POST', authentication, body: { ...precondition, ...extra } });
  const bad = product('BR', { color: 999 });
  const badId = (await insertProductFixture(pool,`INSERT INTO products (full_sku,base_sku,category,weight,total_price_uah,details)
    VALUES ($1,$1,'BR',10,1234.56,$2::jsonb) RETURNING id`, [`BR-BAD-${crypto.randomUUID()}`.toUpperCase(), JSON.stringify(bad.details)])).rows[0].id;
  const before = await state();
  const searched = await request(`${root}/sample-products?q=${encodeURIComponent(stored.BR.full_sku)}`, { authentication: admin });
  assert.equal(searched.response.status, 200, searched.text);
  assert.deepEqual(searched.data.products.map((p) => p.id), [stored.BR.id]);
  assert.deepEqual(Object.keys(searched.data.products[0]).sort(), ['category', 'full_sku', 'id', 'status']);
  const source = await request(`${root}/source-details?category=NM&key=extra`, { authentication: admin });
  assert.equal(source.response.status, 200, source.text);
  assert.ok(source.data.historical.some((q) => q.options.some((o) => o.value_id === '1' && o.sku_code === '901' && o.label === 'Synthetic semantic option')));
  assert.ok(!source.data.historical.some((q) => q.options.some((o) => o.value_id === '0')));
  for (const url of [`${root}/sample-products?q=BR`, `${root}/source-details?category=NM&key=extra`]) {
    assert.equal((await request(url, { authentication: null })).response.status, 401);
    assert.equal((await request(url, { authentication: forbidden })).response.status, 403);
    assert.equal((await request(url, { authentication: pending })).response.status, 403);
  }
  const validation = await command('validate');
  assert.equal(validation.response.status, 422, validation.text);
  assert.deepEqual(validation.data.details.diagnostics.map((v) => [v.sourceId, v.unresolvedValueIds]),
    [['AR.size', ['29', '30', '31']], ['NM.extra', ['0']]]);
  const preview = await command('test-preview', { productIds: [stored.BR.id] });
  assert.equal(preview.response.status, 200, preview.text); // Fails before fix with exact NM/AR source diagnostics.
  assert.equal(preview.data.draftOnly, true); assert.equal(preview.data.publicationReady, false);
  assert.deepEqual(preview.data.globalSourceDiagnostics, validation.data.details.diagnostics);
  assert.deepEqual(preview.data.sampleProducts, [{ productId: stored.BR.id, sku: stored.BR.full_sku, category: 'BR' }]);
  assert.equal(preview.data.previewToken, undefined);
  assert.equal(preview.data.result.readyCount, 1);
  const expectedName = `[ТЕСТ] Браслет з натурального бурштину. Колір: Світлий. Арт: ${stored.BR.full_sku}`;
  assert.ok(preview.data.result.artifacts[0].csvContent.includes(expectedName));
  assert.deepEqual(evaluateProduct(compileDefinition(d), stored.BR).english, evaluateProduct(original, stored.BR).english);
  const published = await command('publish');
  assert.equal(published.response.status, 422); assert.deepEqual(published.data.details.diagnostics, validation.data.details.diagnostics);
  const productFailure = await command('test-preview', { productIds: [badId] });
  assert.equal(productFailure.response.status, 200, productFailure.text);
  assert.equal(productFailure.data.result.readyCount, 0); assert.equal(productFailure.data.result.errors[0].productId, badId);
  assert.ok(productFailure.data.result.errors[0].fields.some((field) => field.field === 'kolir'));
  for (const ids of [[stored.NM.id], [stored.AR.id], [stored.BR.id, stored.AR.id]]) {
    const blocked = await command('test-preview', { productIds: ids });
    assert.equal(blocked.response.status, 422); assert.equal(blocked.data.code, 'TEMPLATE_SOURCE_INVALID');
    assert.equal(blocked.data.result, undefined);
  }
  const missing = await command('test-preview', { productIds: [stored.BR.id, 2147483647] });
  assert.equal(missing.data.code, 'TEMPLATE_PRODUCTS_MISSING'); assert.deepEqual(missing.data.details.missingProductIds, [2147483647]);
  for (const extra of [{ expectedRevision: '999', productIds: [stored.BR.id] },
    { expectedDefinitionHash: 'f'.repeat(64), productIds: [stored.BR.id] }]) {
    assert.equal((await command('test-preview', extra)).data.code, 'TEMPLATE_DRAFT_CONFLICT');
  }
  for (const ids of [[], [stored.BR.id, stored.BR.id], [-1], Array.from({ length: 101 }, (_, i) => i + 1)]) {
    assert.equal((await command('test-preview', { productIds: ids })).data.code, 'TEMPLATE_COMMAND_INVALID');
  }
  assert.equal((await command('test-preview', { productIds: [stored.BR.id], categories: ['BR'] })).data.code, 'TEMPLATE_COMMAND_INVALID');
  assert.equal((await command('test-preview', { productIds: [stored.BR.id] }, null)).response.status, 401);
  assert.equal((await command('test-preview', { productIds: [stored.BR.id] }, pending)).data.code, 'APP_ACCESS_PENDING');
  assert.equal((await command('test-preview', { productIds: [stored.BR.id] }, forbidden)).data.code, 'INSUFFICIENT_PERMISSION');
  const csrf = await request(`${root}/${id}/test-preview`, { method: 'POST', authentication: admin, csrfToken: null,
    body: { ...precondition, productIds: [stored.BR.id] } });
  assert.equal(csrf.response.status, 403);
  assert.deepEqual(await state(), before, 'all reads and failed publication preserve complete business state');

  for (const [change, expectedCode] of [
    [(next) => { next.groups.find((g) => g.route === 'AR').rows[0].cells.name = { op: 'execute' }; }, 'TEMPLATE_INVALID'],
    [(next) => {
      next.sources['NM.sharedUnknown'] = { kind: 'information', category: 'BR', key: 'unknown_shared', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
      next.bindings.push({ id: 'AR.inner', group: 'BR', value: { op: 'text', input: { op: 'source', id: 'NM.sharedUnknown' }, trim: true, format: 'scalar-v1', onAbsent: 'empty' } },
        { id: 'AR.outer', group: 'BR', value: { op: 'ref', id: 'AR.inner' } });
      next.groups.find((g) => g.route === 'BR').rows[1].cells.meta_title = { op: 'ref', id: 'AR.outer' };
    }, 'TEMPLATE_SOURCE_INVALID'],
  ]) {
    const next = structuredClone(d); change(next);
    const variant = await request(root, { method: 'POST', authentication: admin,
      body: { key: `sample-${crypto.randomUUID()}`, displayName: 'Synthetic negative sample', definition: next } });
    assert.equal(variant.response.status, 201, variant.text);
    const previous = await state();
    const rejected = await request(`${root}/${variant.data.id}/test-preview`, { method: 'POST', authentication: admin,
      body: { expectedRevision: variant.data.draft.revision, expectedDefinitionHash: variant.data.draft.definitionHash, productIds: [stored.BR.id] } });
    assert.equal(rejected.response.status, 422); assert.equal(rejected.data.code, expectedCode);
    if (expectedCode === 'TEMPLATE_SOURCE_INVALID') assert.ok(rejected.data.details.diagnostics.some((v) => v.sourceId === 'NM.sharedUnknown'));
    assert.deepEqual(await state(), previous);
  }
});

test('Draft sample display search paginates exact variant SKUs and retains incomplete/archived candidates', async () => {
  const admin = await authenticateApplicationSession(); const prefix = `BR2/${crypto.randomUUID()}`;
  const ids = [];
  for (let i = 0; i < 22; i++) ids.push((await insertProductFixture(pool,`INSERT INTO products
    (full_sku,base_sku,category,status,weight,total_price_uah,details) VALUES ($1,$1,'BR',$2,0,1,'{}') RETURNING id`,
  [`${prefix}-${String(i).padStart(3, '0')}`, i === 0 ? 'archived' : 'active'])).rows[0].id);
  const before = await state();
  const first = await request(`${root}/sample-products?q=${encodeURIComponent(prefix)}`, { authentication: admin });
  assert.equal(first.response.status, 200, first.text); assert.equal(first.data.products.length, 20); assert.equal(first.data.nextOffset, 20);
  const second = await request(`${root}/sample-products?q=${encodeURIComponent(prefix)}&offset=20`, { authentication: admin });
  assert.equal(second.data.products.length, 2); assert.equal(second.data.nextOffset, null);
  assert.deepEqual([...first.data.products, ...second.data.products].map((p) => p.id).sort((a,b) => a-b), ids);
  const exact = await request(`${root}/sample-products?q=${encodeURIComponent((prefix + '-000').toLowerCase())}`, { authentication: admin });
  assert.equal(exact.data.products[0].status, 'archived');
  for (const query of ['q=x', 'q=BR&offset=-1', 'q=BR&limit=1000']) assert.equal((await request(`${root}/sample-products?${query}`, { authentication: admin })).response.status, 400);
  assert.deepEqual(await state(), before);
});
