const { test, assert, pool, Pool, TEST_DATABASE_URL, authenticateApplicationSession, crypto } = require('./suite-context');
const repair = require('../src/services/sv-readiness-repair');
const { insertProductFixture } = require('./product-fixture');
const fixtures = require('../test/fixtures/magento-bindings');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const { hash } = require('../src/services/magento/binding-contract');

test('SV representation repair: authoritative target, preserved pricing/ledgers, CAS, rollback and real race', async (t) => {
  const admin = await authenticateApplicationSession();
  const options = (databasePool = pool) => ({ databasePool, expectedDatabase: new URL(TEST_DATABASE_URL).pathname.slice(1),
    mutationContext: { actorUserId: Number(admin.applicationUser.id), requestId: 'sv-readiness-test' } });
  for (const code of ['BR','NM','KL','CH','AR','SV']) await pool.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING',[code]);
  await pool.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) SELECT 'SV','weight','Weight','text',0,0 WHERE NOT EXISTS(SELECT 1 FROM questions WHERE category_code='SV' AND key='weight')");
  const d = structuredClone(fixtures.definition());
  d.sources = { sku: d.sources.sku, weight: { kind: 'information', category: 'SV', key: 'weight', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] } };
  d.tables = {};
  for (const g of d.groups) for (const row of g.rows) {
    delete row.cells.kolir; delete row.cells.dovzhyna_brasletu_diuimiv; delete row.cells.decor_weight;
  }
  d.groups.find(g => g.route === 'SV').rows[0].cells.decor_weight = { op: 'numberText', input: { op: 'source', id: 'weight' },
    format: 'js-number-positive-v1', error: { op: 'error', field: 'decor_weight', code: 'invalid_weight', message: { op: 'literal', value: 'Positive weight required' } } };
  const family = await templates.createTemplate({ key: `sv-repair-${crypto.randomUUID()}`, displayName: 'SV repair fixture', definition: d }, options());
  const references = require('../src/services/export-templates/source-references');
  assert.deepEqual(references.validateSourceReferences(d, await references.loadSourceEvidence(pool)), []);
  const v = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options());
  const binding = await bindings.createDraft({ installationKey: `sv-repair-${crypto.randomUUID()}`, origin: 'https://fixture.invalid', templateVersionId: v.id,
    observedAt: '2026-09-01T00:00:00.000Z', schema: fixtures.schema() }, options());
  let sequence = 0;
  const fixture = async () => {
    const sku = `SV-REPAIR-${++sequence}`;
    const p = (await insertProductFixture(pool, `INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES($1,$1,0,'SV',5.2,10,420,2,42,'{"answers":{"souvenir":1,"weight":"5,2"},"manualPriceUah":420}') RETURNING id`, [sku])).rows[0];
    await pool.query('INSERT INTO sku_registry(full_sku,first_product_id) VALUES($1,$2) ON CONFLICT(full_sku) DO NOTHING', [sku,p.id]);
    return p;
  };
  const planFor = async p => {
    const plan = await repair.preview({ ...options(), bindingRevisionId: binding.id });
    const entry = plan.entries.find(e => e.productId === p.id); assert.equal(entry.eligible, true, JSON.stringify(entry));
    return { plan, entry, opts: { ...options(), expectedHash: plan.planHash } };
  };
  const state = async id => (await pool.query('SELECT to_jsonb(p) product,to_jsonb(f) lifecycle FROM products p JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=$1',[id])).rows[0];
  const ledgers = async () => {
    const out = {};
    for (const table of ['sku_registry','export_state','export_snapshots','export_snapshot_products','product_export_revisions','price_export_snapshots','magento_binding_revisions']) out[table] = hash((await pool.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows);
    return out;
  };
  await t.test('preview is read only; minimal apply and exact retry preserve all protected state', async () => {
    const p = await fixture(), before = await state(p.id), protectedBefore = await ledgers();
    const { plan,entry,opts } = await planFor(p); assert.deepEqual(await state(p.id), before);
    await assert.rejects(repair.applyEntry(plan, entry, { ...opts, mutationContext: { actorUserId: 9999999 } }), { code: 'ADMIN_PERMISSION_REVOKED' });
    const result = await repair.applyEntry(plan, entry, opts); assert.equal(result.targetReady, true);
    const after = await state(p.id);
    assert.deepEqual(after.product, repair.targetProduct(before.product));
    for (const k of Object.keys(before.lifecycle).filter(k => !['revision','updated_at'].includes(k))) assert.deepEqual(after.lifecycle[k],before.lifecycle[k],k);
    assert.equal(after.lifecycle.revision, before.lifecycle.revision + 1); assert.deepEqual(await ledgers(), protectedBefore);
    assert.equal((await repair.applyEntry(plan, entry, opts)).alreadyApplied, true);
    assert.deepEqual(await state(p.id), after);
    assert.equal((await repair.preview({ ...options(), bindingRevisionId: binding.id })).entries.find(e=>e.productId===p.id).eligible,false);
  });
  await t.test('stale source, changed lifecycle and audit failure roll back; mixed batch never credits failure', async () => {
    const p = await fixture(), before = await state(p.id); const { plan,entry,opts } = await planFor(p);
    const broken = { connect: async () => { const c = await pool.connect(); return { release:()=>c.release(),query:(sql,args)=>{ if (/INSERT INTO audit_events/.test(sql)) throw Error('audit failure'); return c.query(sql,args); } }; } };
    await assert.rejects(repair.applyEntry(plan,entry,{ ...opts,databasePool:broken }), /audit failure/); assert.deepEqual(await state(p.id),before);
    await pool.query("UPDATE products SET total_price_uah=421 WHERE id=$1",[p.id]);
    await assert.rejects(repair.applyEntry(plan,entry,opts), { code:'SV_REPAIR_CONFLICT' });
    const next = await planFor(p);
    await pool.query('UPDATE product_full_export_state SET delivery_version=delivery_version+1 WHERE product_id=$1',[p.id]);
    const batch = await repair.apply(next.plan,next.opts);
    assert.ok(batch.conflicted.includes(p.id)); assert.ok(!batch.succeeded.includes(p.id));
    assert.equal((await state(p.id)).product.details.answers.weight,'5,2');
  });
  await t.test('two independent connections wait on a real product lock and produce one mutation/receipt', async () => {
    const p = await fixture(); const { plan,entry,opts } = await planFor(p);
    const a = new Pool({ connectionString:TEST_DATABASE_URL,max:1 }), b = new Pool({ connectionString:TEST_DATABASE_URL,max:1 });
    const holder = await pool.connect(), pending = [];
    try {
      const apid=(await a.query('SELECT pg_backend_pid() pid')).rows[0].pid, bpid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await holder.query('BEGIN'); await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[p.id]);
      const wait = async pid => { for(let i=0;i<600;i++){if((await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked)return;await new Promise(r=>setTimeout(r,10));}assert.fail('no lock contention'); };
      pending.push(repair.applyEntry(plan,entry,{ ...opts,databasePool:a })); pending[0].catch(()=>{}); await wait(apid);
      pending.push(repair.applyEntry(plan,entry,{ ...opts,databasePool:b })); pending[1].catch(()=>{}); await wait(bpid);
      await holder.query('COMMIT'); const results=await Promise.all(pending); assert.equal(results.filter(r=>r.alreadyApplied).length,1);
      assert.equal((await state(p.id)).product.details.answers.weight,'5.2');
      assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.sv_weight_representation_repaired' AND details->'result'->>'productId'=$1",[String(p.id)])).rows[0].n,1);
    } finally { await holder.query('ROLLBACK');holder.release();await Promise.allSettled(pending);await a.end();await b.end(); }
  });
  await t.test('duplicate Amber SKU blocks every owner despite a valid decimal representation', async () => {
    const p = await fixture(); const before = await state(p.id);
    // Reproduce a pre-registry legacy duplicate only in this disposable fixture.
    const c = await pool.connect(); let duplicate;
    try {
      await c.query('BEGIN'); await c.query('ALTER TABLE products DISABLE TRIGGER products_reserve_sku');
      duplicate = (await insertProductFixture(c, `INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
        SELECT full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details FROM products WHERE id=$1 RETURNING id`, [p.id])).rows[0];
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await c.query('ALTER TABLE products ENABLE TRIGGER products_reserve_sku'); await c.query('COMMIT');
    } finally { await c.query('ROLLBACK'); c.release(); }
    const plan = await repair.preview({ ...options(), bindingRevisionId: binding.id });
    for (const id of [p.id,duplicate.id]) {
      const entry = plan.entries.find(e=>e.productId===id);
      assert.equal(entry.eligible,false); assert.ok(entry.blockers.includes('SKU_IDENTITY_CONFLICT'));
      await assert.rejects(repair.applyEntry(plan,entry,{ ...options(),expectedHash:plan.planHash }),{ code:'SV_REPAIR_CONFLICT' });
    }
    assert.deepEqual(await state(p.id),before);
  });
});
