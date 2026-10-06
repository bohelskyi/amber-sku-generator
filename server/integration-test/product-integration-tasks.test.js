const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('durable integration tasks preserve inputs, isolate owners, dedupe real races and resolve only current local configuration', async () => {
  const sourceUrl = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(sourceUrl.hostname, '127.0.0.1');
  assert.equal(sourceUrl.port, '55432');
  assert.ok(sourceUrl.pathname.endsWith('_test'));
  const name = `amber_integration_tasks_${process.pid}_test`;
  const control = new Client({ connectionString: sourceUrl.toString() });
  await control.connect();
  let db, appPool, created = false; const previousFetch = global.fetch;
  global.fetch = async () => { assert.fail('No external HTTP allowed in this local configuration fixture'); };
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0,
      'Never drop or reuse a database that this test did not create');
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(sourceUrl); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.NBU_RATE_OVERRIDE = '40';
    process.env.MAGENTO_BASE_URL = '';
    require('../test/setup-env');
    appPool = require('../src/db/pool');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    await require('../src/db/run-migrations').runMigrations();
    const actor = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Native evaluator fixture') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: appPool, mutationContext: { actorUserId: actor } };
    for (const [category, key, values] of [['NM', 'extra', [1, 2]], ['AR', 'size', Array.from({ length: 31 }, (_, i) => i + 1)]]) {
      await db.query("INSERT INTO categories(code,name,requires_weight,sku_publication_mode) VALUES($1,$1,0,'explicit')", [category]);
      const question = (await db.query(`INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type)
        VALUES($1,$2,$2,1,1,0,'options') RETURNING id`, [category, key])).rows[0].id;
      for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [question, value, String(value)]);
      // Historical configuration supplies the old publication's existing proof.
      // New products below never use this schema or allocate an encoded SKU.
      await require('../src/services/sku-schema.service').publishSkuSchema(category, options);
    }
    const fixture = require('../test/fixtures/magento-v4');
    const { upgradeColumns } = require('../src/services/export-templates/column-contract');
    const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
    const { compileDefinition } = require('../src/services/export-templates/definition');
    const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
    const { officeCatalog, officeEvidence } = require('../test/fixtures/magento-v1/office');
    const frozenOffice = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
    const definition = fixture.definition(['NM', 'AR']);
    const text = (id) => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
    definition.sources = { sku: definition.sources.sku, price: definition.sources.price };
    definition.tables = {}; definition.questionContracts = {};
    definition.sourceSupport = structuredClone(frozenOffice.sourceSupport);
    for (const [category, key, values] of [['NM', 'extra', [1, 2]], ['AR', 'size', Array.from({ length: 31 }, (_, i) => i + 1)]]) {
      const source = `${category}.${key}`;
      definition.sources[source] = structuredClone(frozenOffice.sources[source]);
      definition.questionContracts[source] = { source, exists: true, required: false, rule: {}, allowed: values.map(String) };
      definition.tables[category] = Object.fromEntries(values.map((value) => [value, 'Red output']));
      const group = definition.groups.find((g) => g.route === category);
      group.columns.push('kolir');
      for (const row of group.rows) row.cells.kolir = { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: source } },
        table: category, otherwise: { op: 'error', field: 'kolir', message: { op: 'literal', value: 'Missing value' } } };
      group.rows.forEach((row) => { row.cells.price = text('price'); });
    }
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'native-frozen4', displayName: 'Native frozen four', definition }, options);
    const oldVersion = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service');
    const schema = fixture.observation();
    const config = { configured: true, baseUrl: 'https://native-evaluator.invalid' };
    options.creationDeliveryConfig = config;
    let oldDraft = await bindings.createDraft({ installationKey: 'native-eval5', origin: config.baseUrl, templateVersionId: oldVersion.id,
      observedAt: new Date().toISOString(), schema }, options);
    oldDraft = await bindings.updateDraft(oldDraft.id, { expectedRevision: oldDraft.revision, bindings: fixture.approvedBindings(definition, schema) }, options);
    const oldBinding = await bindings.publishDraft(oldDraft.id, { expectedRevision: oldDraft.revision, expectedCurrentId: null }, options);
    const registryBefore = (await db.query('SELECT * FROM sku_registry ORDER BY full_sku')).rows;
    const oldVersionBefore = (await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [oldVersion.id])).rows[0];
    const oldBindingBefore = await bindings.getRevision(oldBinding.id, options);
    const activationEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('public_sku.activated',$1,'{"displayName":"Native evaluator fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    const cutoverEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Native evaluator fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
      activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor, activationEvent]);
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='native-eval5',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('COMMIT');

    const tasks=require('../src/services/product-integration-tasks.service');
    const productService=require('../src/services/product.service');
    const taskOptions={...options,config};
    const beforeCounts=(await db.query(`SELECT (SELECT count(*) FROM products) products,
      (SELECT count(*) FROM public_product_identities) identities,(SELECT count(*) FROM sku_registry) reserved,
      (SELECT count(*) FROM product_characteristic_versions) characteristic_versions,
      (SELECT count(*) FROM magento_sync_jobs) jobs,(SELECT count(*) FROM magento_configuration_actions) actions`)).rows[0];
    const makeCommand=async(value=1,photoIds=[])=>{
      const product={categoryCode:'NM',answers:{extra:value},weight:1,pricingDecision:{mode:'manual_uah',manualPriceUah:100},photoIds};
      const preview=await productService.buildNewProductPreview(product,{creationDeliveryConfig:config});
      return {clientRequestId:crypto.randomUUID(),expectedPreviewToken:preview.previewToken,product};
    };
    const first=await makeCommand();
    let entered=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    const racing={...taskOptions,buildPreview:async(...args)=>{
      const result=await productService.buildNewProductPreview(...args);entered++;if(entered===2)release();await barrier;return result;
    }};
    const [left,right]=await Promise.all([tasks.create(first,racing),tasks.create(first,racing)]);
    assert.equal(left.id,right.id);assert.equal(left.state,'open');assert.equal(left.deliveryAccepted,false);
    assert.deepEqual(left.creationContext.product.answers,{extra:1});
    assert.equal((await db.query('SELECT count(*)::int n FROM product_integration_tasks')).rows[0].n,1);
    assert.equal((await db.query('SELECT count(*)::int n FROM product_integration_task_attempts')).rows[0].n,1);
    assert.equal((await tasks.recover(first.clientRequestId,taskOptions)).id,left.id);
    assert.equal((await tasks.create(first,taskOptions)).id,left.id);
    await assert.rejects(tasks.create({...first,product:{...first.product,weight:2}},taskOptions),{code:'INTEGRATION_TASK_IDEMPOTENCY_CONFLICT'});
    const next=await makeCommand(2);
    assert.equal((await tasks.create(next,taskOptions)).id,left.id,'new inputs reuse the same exact open defect');
    assert.deepEqual((await tasks.read(left.id,taskOptions)).creationContext.product.answers,{extra:2},'latest accepted inputs can be explicitly restored');
    assert.equal((await db.query('SELECT count(*)::int n FROM product_integration_task_attempts')).rows[0].n,2);
    const ownedPhotos=[crypto.randomUUID(),crypto.randomUUID()];
    for(const [index,id] of ownedPhotos.entries()) await db.query(
      `INSERT INTO product_photo_assets(id,actor_user_id,request_key,content_hash,mime_type,display_name,content,expires_at)
       VALUES($1,$2,$3,$4,'image/png',$5,$6,CURRENT_TIMESTAMP+interval '3 seconds')`,
      [id,actor,crypto.randomUUID(),'b'.repeat(64),`neutral-${index}.png`,Buffer.alloc(32)]);
    const photoCommand=await makeCommand(2,[...ownedPhotos].reverse());
    assert.equal((await tasks.create(photoCommand,taskOptions)).id,left.id);
    const photoContext=(await tasks.read(left.id,taskOptions)).creationContext;
    assert.equal(photoContext.canResume,true);
    assert.deepEqual(photoContext.photos.map(photo=>photo.id),[...ownedPhotos].reverse());
    assert.deepEqual(photoContext.product.photoIds,[...ownedPhotos].reverse());
    await assert.rejects(tasks.create(await makeCommand(2,[crypto.randomUUID()]),taskOptions),
      {code:'INTEGRATION_TASK_PHOTOS_UNAVAILABLE'});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,
      Math.max(...photoContext.photos.map(photo=>new Date(photo.expiresAt).getTime()))-Date.now()+100)));
    const expiredContext=(await tasks.read(left.id,taskOptions)).creationContext;
    assert.equal(expiredContext.canResume,false);
    assert.deepEqual(expiredContext.unavailablePhotoIds,[...ownedPhotos].reverse());
    await assert.rejects(tasks.create(await makeCommand(2,ownedPhotos),taskOptions),
      {code:'INTEGRATION_TASK_PHOTOS_UNAVAILABLE'});
    await assert.rejects(db.query('UPDATE product_integration_task_attempts SET creation_payload=$1',[JSON.stringify(first.product)]),/immutable/);
    await assert.rejects(db.query("DELETE FROM product_integration_tasks WHERE id=$1",[left.id]),/permanent/);
    const owner=(await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Other creator') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='storekeeper'",[owner]);
    const other={...taskOptions,mutationContext:{actorUserId:Number(owner)}};
    assert.deepEqual(await tasks.list({},other),{items:[],nextOffset:null});
    await assert.rejects(tasks.read(left.id,other),{code:'INTEGRATION_TASK_ACCESS_DENIED'});
    await assert.rejects(tasks.resolution(left.id,other),{code:'INTEGRATION_TASK_ACCESS_DENIED'});
    const otherCommand=await makeCommand();const otherTask=await tasks.create(otherCommand,other);
    const inspectedOther=await tasks.read(otherTask.id,taskOptions);
    assert.equal(inspectedOther.resumeHref,null);assert.equal(inspectedOther.creationContext.product,undefined);
    assert.equal(inspectedOther.creationContext.photoCount,0);
    const unresolved=await tasks.resolution(left.id,taskOptions);assert.equal(unresolved.resolved,false);assert.equal(unresolved.resolutionToken,null);
    await assert.rejects(tasks.resolve(left.id,{expectedRevision:'1',resolutionToken:'a'.repeat(64)},taskOptions),{code:'INTEGRATION_TASK_NOT_READY'});
    // Reviewed local successor publication clears this exact defect, without a product or Magento write.
    const nextFamily=await templates.createTemplate({key:'integration-task-native-five',displayName:'Task native five',definition:oldVersion.definition},options);
    const upgraded=await templates.upgradeDraft(nextFamily.id,{expectedRevision:nextFamily.draft.revision,
      expectedDefinitionHash:nextFamily.draft.definitionHash,targetContract:'public-product-characteristics-v1'},options);
    const nextVersion=await templates.publishTemplate(nextFamily.id,{expectedRevision:upgraded.revision,expectedDefinitionHash:upgraded.definitionHash},options);
    let draft=await bindings.createDraft({installationKey:'native-eval5',origin:config.baseUrl,templateVersionId:nextVersion.id,
      observedAt:new Date().toISOString(),schema},options);
    draft=await bindings.updateDraft(draft.id,{expectedRevision:draft.revision,bindings:fixture.approvedBindings(nextVersion.definition,schema)},options);
    await bindings.publishDraft(draft.id,{expectedRevision:draft.revision,expectedCurrentId:oldBinding.id},options);
    const ready=await tasks.resolution(left.id,taskOptions);assert.equal(ready.resolved,true);assert.match(ready.resolutionToken,/^[a-f0-9]{64}$/);
    await assert.rejects(tasks.resolve(left.id,{expectedRevision:'1',resolutionToken:'a'.repeat(64)},taskOptions),{code:'INTEGRATION_TASK_RESOLUTION_STALE'});
    const concurrent=await Promise.allSettled([
      tasks.resolve(left.id,{expectedRevision:ready.revision,resolutionToken:ready.resolutionToken},taskOptions),
      tasks.resolve(left.id,{expectedRevision:ready.revision,resolutionToken:ready.resolutionToken},taskOptions)]);
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1,'one durable acknowledgement wins');
    assert.equal(concurrent.find(result=>result.status==='rejected').reason.code,'INTEGRATION_TASK_NOT_OPEN');
    const resolved=concurrent.find(result=>result.status==='fulfilled').value;
    assert.equal(resolved.state,'resolved');assert.equal(resolved.revision,'2');assert.equal(resolved.deliveryAccepted,false);
    assert.equal((await tasks.recover(first.clientRequestId,taskOptions)).state,'resolved');
    await assert.rejects(tasks.resolve(left.id,{expectedRevision:'2',resolutionToken:ready.resolutionToken},taskOptions),{code:'INTEGRATION_TASK_NOT_OPEN'});
    await assert.rejects(db.query("UPDATE product_integration_tasks SET state='open' WHERE id=$1",[left.id]),/immutable/);
    assert.deepEqual((await db.query(`SELECT (SELECT count(*) FROM products) products,
      (SELECT count(*) FROM public_product_identities) identities,(SELECT count(*) FROM sku_registry) reserved,
      (SELECT count(*) FROM product_characteristic_versions) characteristic_versions,
      (SELECT count(*) FROM magento_sync_jobs) jobs,(SELECT count(*) FROM magento_configuration_actions) actions`)).rows[0],beforeCounts);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.integration_task_created'")).rows[0].n,2);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.integration_task_resolved'")).rows[0].n,1);
    const publishedBefore=(await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1',[oldVersion.id])).rows[0];
    assert.deepEqual(publishedBefore,oldVersionBefore);
  } finally {
    global.fetch = previousFetch;
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) {
      await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]);
      await control.query(`DROP DATABASE ${name}`);
    }
    await control.end();
  }
});
