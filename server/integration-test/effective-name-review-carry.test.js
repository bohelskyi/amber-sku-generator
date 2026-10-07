const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = require('./harness');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const review = require('../src/services/magento/binding-review');
const decisions = require('../src/services/magento/integration-binding-review');
const carry = require('../src/services/magento/binding-carry-forward');
const { upgradeNameReadiness } = require('../src/services/export-templates/effective-product-names');

test('reviewed names carry repairs the exact existing draft, preserves actual manual choices and refuses stale counters', async () => {
  const name = 'amber_names_review_carry_test', url = await recreateTestDatabase(name), db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Names carry admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } }, f = require('../test/fixtures/magento-successor').fixture();
    for (const g of f.old.groups) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [g.route]);
    for (const [id, source] of Object.entries(f.old.sources)) {
      if (source.kind === 'product') continue;
      const q = (await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required)
        VALUES($1,$2,$2,$3,0,0) RETURNING id`, [source.category, source.key, source.kind === 'semantic' ? 'options' : 'text'])).rows[0];
      const values = [...new Set(Object.values(f.old.questionContracts).filter(q => q.source === id).flatMap(q => q.allowed))];
      for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [q.id, value, value]);
    }
    async function version(definition, key) {
      const family = await templates.createTemplate({ key, displayName: key, definition }, options);
      return templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    }
    const oldVersion = await version(f.old, 'names-old'), nextVersion = await version(upgradeNameReadiness(f.old), 'names-next');
    const config = { configured: true, baseUrl: 'https://successor.invalid' };
    let source = await bindings.createDraft({ installationKey: 'names-carry', origin: config.baseUrl, templateVersionId: oldVersion.id, observedAt: new Date().toISOString(), schema: f.schema }, options);
    source = await bindings.updateDraft(source.id, { expectedRevision: source.revision, bindings: f.source.bindings }, options);
    source = await bindings.publishDraft(source.id, { expectedRevision: source.revision, expectedCurrentId: null }, options);
    const sourceBefore = await bindings.getRevision(source.id, options);
    const initial = f.candidates(nextVersion.definition), schema = structuredClone(f.schema);
    const selected = initial.options.find(o => o.sourceKind === 'semantic' && o.optionId
      && initial.options.filter(other => other.bindingKey === o.bindingKey && other.evaluatedOutput === o.evaluatedOutput).length === 1);
    assert.ok(selected);
    const selectedAttribute = initial.attributes.find(a => a.bindingKey === selected.bindingKey);
    schema.attributes.find(a => a.attribute_code === selectedAttribute.attributeCode).options.push({ value: '999999', label: selected.evaluatedOutput });
    let draft = await bindings.createDraft({ installationKey: 'names-carry', origin: config.baseUrl, templateVersionId: nextVersion.id, observedAt: new Date().toISOString(), schema, bindings: initial }, options);
    const selectedId = review.review(draft).find(e => e.kind === 'option' && e.source === selected.sourceKey && e.target === selectedAttribute.target && e.routeKey === selectedAttribute.routeKey && e.row === selectedAttribute.rowId).id;
    draft = await decisions.select(config, draft.id, { expectedRevision: draft.revision, binding: selectedId, identity: '999999' }, options);
    draft = await decisions.decide(config, draft.id, { expectedRevision: draft.revision, binding: selectedId, action: 'approve', acceptReview: true, reason: 'Actual alternative chosen in this draft' }, options);
    const policy = review.review(draft).find(e => e.kind === 'policy' && e.target === 'price');
    draft = await decisions.decide(config, draft.id, { expectedRevision: draft.revision, binding: policy.id, action: 'approve', policy: 'magento_managed', acceptReview: true, reason: 'Actual ownership chosen in this draft' }, options);
    const remote = { ...options, config, fetchImpl: async () => assert.fail('No real Magento access permitted') };
    const request = () => ({ expectedDatabase: name, actorUserId: actor, sourceId: source.id, sourceRevision: source.revision, targetId: draft.id, targetRevision: draft.revision });
    const stale = await carry.preflight(request(), remote);
    const extra = review.review(draft).find(e => e.kind === 'attribute' && e.target === 'name');
    const independent = new Pool({ connectionString: url });
    try { draft = await decisions.decide(config, draft.id, { expectedRevision: draft.revision, binding: extra.id, action: 'approve', acceptReview: true, reason: 'Already reviewed this name in the current draft' }, { ...options, databasePool: independent }); }
    finally { await independent.end(); }
    const manualBefore = await bindings.getRevision(draft.id, options);
    await assert.rejects(carry.apply({ expectedDatabase: name, actorUserId: actor, plan: stale.plan, planHash: stale.planHash }, remote), { code: 'MAGENTO_BINDING_CARRY_PREFLIGHT_STALE' });
    assert.deepEqual(await bindings.getRevision(draft.id, options), manualBefore);
    const plan = await carry.preflight(request(), remote);
    assert.deepEqual(plan.blockers, []);
    assert.ok(plan.plan.summary.approvalsCarried > 0);
    assert.ok(plan.plan.preservedDraftDecisions.some(e => e.kind === 'option' && e.identity === '999999'));
    const input = { expectedDatabase: name, actorUserId: actor, plan: plan.plan, planHash: plan.planHash };
    const receipt = await carry.apply(input, remote), after = await bindings.getRevision(draft.id, options);
    assert.equal(receipt.targetRevisionId, draft.id); assert.equal(after.state, 'draft');
    assert.equal(after.revision, receipt.targetRevisionAfter);
    assert.deepEqual(after.bindings.options.find(o => o.bindingKey === selected.bindingKey && o.sourceKey === selected.sourceKey), manualBefore.bindings.options.find(o => o.bindingKey === selected.bindingKey && o.sourceKey === selected.sourceKey));
    for (const id of [policy.id, extra.id]) assert.deepEqual(review.review(after).find(e => e.id === id), review.review(manualBefore).find(e => e.id === id));
    for (const route of after.bindings.routes) assert.equal(route.reviewState, 'approved');
    assert.ok(after.bindings.attributes.filter(a => a.target !== 'name').every(a => a.reviewState === 'approved'));
    assert.ok(after.bindings.attributes.filter(a => a.target === 'name' && a.bindingKey !== extra.id.slice('attribute:'.length)).every(a => a.reviewState !== 'approved'));
    assert.equal((await carry.apply(input, remote)).alreadyApplied, true);
    assert.deepEqual(await bindings.getRevision(draft.id, options), after);
    assert.deepEqual(await bindings.getRevision(source.id, options), sourceBefore);
    assert.equal((await bindings.getCurrentPublished('names-carry', options)).id, source.id);
    for (const v of [oldVersion, nextVersion]) assert.deepEqual((await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [v.id])).rows[0], { definition: v.definition, definition_hash: v.definitionHash });
    for (const table of ['products', 'magento_sync_jobs', 'magento_product_sync_requests']) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    assert.equal(Number((await db.query('SELECT count(*) n FROM audit_events WHERE event_key=$1 AND subject_id=$2', [carry.EVENT, draft.id])).rows[0].n), 1);
  } finally { await db.end(); await dropTestDatabase(name); }
});
