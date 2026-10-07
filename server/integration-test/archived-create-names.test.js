const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');

test('archived CREATE manual subjects satisfy the unchanged SV published contract without activation or delivery', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_create_names_${process.pid}_${randomBytes(6).toString('hex')}_test`;
  const expected = [...new Set(['amber_test', 'postgres', 'template0', 'template1', source.pathname.slice(1)])].sort();
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  let db, appPool, created = false;
  try {
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r => r.datname), expected);
    assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(source); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.MAGENTO_BASE_URL = ''; process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env'); appPool = require('../src/db/pool'); db = new Pool({ connectionString: url.toString(), max: 8 });
    await require('../src/db/run-migrations').runMigrations();
    const c = require('../src/services/magento/binding-contract');
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Create names fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    for (const category of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name,requires_weight) VALUES($1,$1,0)', [category]);
    const souvenir=(await db.query("INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type) VALUES('SV','souvenir','Synthetic souvenir',1,0,1,'options') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,4,'4','Synthetic sign'),($1,6,'6','Synthetic key chain')",[souvenir]);
    const { insertProductFixture, insertNativeProductFixture } = require('./product-fixture');
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details)
      VALUES('SV2314003','SV',25000,531,'archived',1,'{"answers":{"souvenir":"4","weight":531},"logMessage":"unknown prior archive"}') RETURNING *`)).rows[0];
    const other=(await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details,
        magento_name_subject_ua,magento_name_subject_en) VALUES('SV2314004','SV',24000,500,'archived',1,'{"answers":{"souvenir":"4","weight":500}}','Другий тест','Second test') RETURNING *`)).rows[0];
    const config = { configured: true, baseUrl: 'https://create-names.invalid', consumerKey: 'create-names-consumer-unique', consumerSecret: 'create-names-secret-unique', accessToken: 'create-names-access-unique', accessTokenSecret: 'create-names-access-secret-unique' };
    const options = { databasePool: db, config, reviewSecret: 'synthetic-archived-name-review-secret', actorUserId: actor, mutationContext: { actorUserId: actor, requestId: 'create-names-fixture' } };
    const fixture = require('../test/fixtures/magento-bindings'); const definition = structuredClone(fixture.definition());
    const actual = require('../src/services/export-templates/magento-v1-definition').materializeMagentoV1(new Map(), { publicSku: true });
    definition.sources = { sku: definition.sources.sku, price: { kind: 'product', field: 'total_price_uah', type: 'scalar' },
      ...Object.fromEntries(['public_sku','magento_name_subject_ua','magento_name_subject_en','SV.souvenir'].map(key => [key, actual.sources[key]])) };
    definition.evaluatorVersion = actual.evaluatorVersion; definition.sourceContractVersion = actual.sourceContractVersion;
    definition.tables = {};
    definition.bindings = actual.bindings.filter(b => b.id === 'sku' || /^SV\.(manual|automatic|name)/.test(b.id));
    definition.groups.find(g => g.route === 'SV').evaluate = [{ op:'ref', id:'SV.nameCheck' }];
    for (const group of definition.groups) for (const row of group.rows) {
      row.cells = Object.fromEntries(Object.entries(row.cells).filter(([key]) => ['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type', 'price'].includes(key)));
      row.cells.name = group.route === 'SV' ? actual.groups.find(g => g.route === 'SV').rows.find(r => r.id === row.id).cells.name : { op:'literal', value:'Other fixture name' };
      row.cells.price = row.id === 'base' ? { op: 'text', input: { op: 'source', id: 'price' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' } : { op: 'literal', value: '' };
      row.cells.product_online = { op: 'literal', value: row.id === 'base' ? '2' : '' };
      row.cells.visibility = { op: 'literal', value: row.id === 'base' ? 'Catalog, Search' : '' };
    }
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'create-names-fixture', displayName: 'Create names fixture', definition }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service'), schema = fixture.schema(); schema.attributes.find(a => a.attribute_code === 'name').scope = 'store';
    let draft = await bindings.createDraft({ installationKey: 'create-names', origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema }, options);
    const decisions = fixture.approvedBindings(definition, schema, 'SV');
    const native = { attribute_set_code: 'attribute_set_id', product_type: 'type_id', store_view_code: 'store_view_code', product_online: 'status', visibility: 'visibility' };
    decisions.attributes.forEach(a => { if (a.strategy === 'transport_control') a.transportTarget = `product.${native[a.target]}`; });
    const bindingKey = require('../src/services/magento/binding-validation').bindingKey;
    decisions.policies.forEach(p => {
      const a = decisions.attributes.find(a => bindingKey(a.routeKey, a.rowId, a.target) === p.bindingKey);
      p.policy = p.storeCode === 'en' && a.target !== 'name' ? 'magento_managed' : 'authoritative_create_update';
      if (a.target === 'product_online') { p.policy = 'initialize_create_only'; p.evidence = { createValue: 2 }; }
      if (a.target === 'visibility') p.policy = 'initialize_create_only';
    });
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: decisions }, options);
    const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
    const client = await db.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL amber.lifecycle_maintenance='on'"); await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
      const event = (await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES('product.fixture',$1,'{"displayName":"Create names fixture","preferredUsername":null}','fixture','create-names','fixture') RETURNING id`, [actor])).rows[0].id;
      await client.query("SET LOCAL amber.public_sku_activation='on'");
      await client.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor,event]);
      await client.query(`UPDATE full_product_export_activation SET phase='preparing',generation=generation+1,manifest_hash=$1,approval_event_id=$2 WHERE singleton`, [c.hash('create-names'), event]);
      await client.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,generation=generation+1,activation_event_id=$1 WHERE singleton`, [event]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='create-names',actor_user_id=$1,legacy_product_csv_enabled=FALSE,
        cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, event]);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await db.query("INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state,reason_code) VALUES($1,$2,'needs_attention','product_retired')", [product.public_product_identity_id, product.id]);

    let remotePresent=false, onGet=null; const requests=[];
    options.fetchImpl=async (url,init={}) => {
      assert.equal(init.method || 'GET','GET','Manual completion never writes Magento');
      const parsed=new URL(url); assert.equal(parsed.origin,config.baseUrl);requests.push(parsed.pathname);
      const present=remotePresent && parsed.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]')==='SV2314003';
      if(onGet) await onGet(parsed);
      let value;
      if(parsed.pathname.endsWith('/categories'))value={id:803,parent_id:1,name:'Default',children_data:[]};
      else { assert.ok(parsed.pathname.endsWith('/products'));value={items:present?[{id:900001,sku:'SV2314003',attribute_set_id:8001,name:'Unexpected remote',price:25000,status:2,visibility:4,type_id:'simple',custom_attributes:[],extension_attributes:{category_links:[],website_ids:[801]}}]:[],total_count:present?1:0}; }
      return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    };
    let schemaPasses=0;
    options.discover=async()=>{schemaPasses++;return schema;};
    const historical=require('../src/services/historical-standard-reactivation.service'), namesService=require('../src/services/product-magento-name.service');
    const command={productId:Number(product.id),article:'SV2314003',bindingRevisionId:published.id,intent:'historical-create'};
    // Explicit synthetic operator input, not an inferred title for the real SKU.
    const pair={subjectUa:'Тестовий знак «А»',subjectEn:'Test sign A'};
    const proposed={...command,...pair};
    const apply=(review,overrides={})=>namesService.applyProductMagentoName({...proposed,previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt},{...options,...overrides});
    const authorized=operation=>require('../src/services/access-admin-transaction').runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'products.archive',createError:c.error,operation});
    const mutate=(sql,values)=>authorized(client=>client.query(sql,values));
    const snapshot=async()=> (await db.query(`SELECT
      (SELECT to_jsonb(p) FROM products p WHERE id=$1) product,
      (SELECT to_jsonb(f) FROM product_full_export_state f WHERE product_id=$1) lifecycle,
      (SELECT to_jsonb(r) FROM magento_product_sync_requests r WHERE product_id=$1) request,
      (SELECT jsonb_agg(j) FROM magento_sync_jobs j) jobs,
      (SELECT jsonb_agg(n) FROM magento_name_sync_states n) names,
      (SELECT count(*)::int FROM historical_standard_intents) intents,
      (SELECT count(*)::int FROM audit_events) audits`,[product.id])).rows[0];
    await t.test('local preparation and preview avoid Magento; one fresh target plan saves, one explicit final review follows',async()=>{
      const phases=[];
      const phase=async(label,operation)=>{const before=requests.length,schemas=schemaPasses;const value=await operation();
        phases.push({label,schemaPasses:schemaPasses-schemas,gets:requests.slice(before)});return value;};
      await phase('initial-list',()=>historical.preview({skus:[command.article]},options));
      await phase('open-form',()=>namesService.previewProductMagentoName(command,options));
      const review=await phase('formed-names',()=>namesService.previewProductMagentoName(proposed,options));
      await phase('save-pair',()=>apply(review));
      await phase('explicit-final-list',()=>historical.preview({skus:[command.article]},options));
      assert.deepEqual(phases.map(p=>p.schemaPasses),[1,0,0,1,1]);
      assert.deepEqual(phases.map(p=>p.gets.length),[2,0,0,2,2]);
      console.log('MANUAL_NAME_WORKFLOW_OPTIMIZED '+JSON.stringify({phases,schemaPasses:phases.reduce((sum,p)=>sum+p.schemaPasses,0),gets:phases.reduce((sum,p)=>sum+p.gets.length,0)}));
      await mutate('UPDATE products SET magento_name_subject_ua=NULL,magento_name_subject_en=NULL,magento_name_review_required=FALSE WHERE id=$1',[product.id]);
    });
    await t.test('the old SV manualPair requirement remains; historical preview exposes only the name completion capability',async()=>{
      const before=await snapshot(),review=await historical.preview({skus:[command.article]},options),item=review.items[0];
      assert.equal(item.disposition,'blocked');assert.equal(item.deliveryMode,'create');assert.equal(item.remoteProductId,null);
      assert.ok(item.deliveryBlockerCodes.includes('PRODUCT_EVALUATION_NOT_READY'));assert.equal(item.manualNameCompletion,true);
      assert.equal(definition.nameReadiness,undefined);assert.deepEqual(await snapshot(),before);
    });
    await t.test('preview validates the explicit subject pair through the actual published evaluator without writes',async()=>{
      const before=await snapshot(),current=await namesService.previewProductMagentoName(command,options);
      assert.equal(current.alreadyCompleted,false);assert.equal(current.subjectUa,null);assert.equal(current.subjectEn,null);
      const review=await namesService.previewProductMagentoName(proposed,options);
      assert.equal(review.nameUa,pair.subjectUa+' з бурштину. Арт: SV2314003');assert.equal(review.nameEn,'Amber '+pair.subjectEn+'. Art: SV2314003');
      assert.equal(review.deliveryMode,'create');assert.equal(review.remoteProductId,null);assert.match(review.previewToken,/^[a-f0-9]{64}$/);
      assert.deepEqual(await snapshot(),before);
      await assert.rejects(namesService.previewProductMagentoName({productId:command.productId},{...options}),/активного сувеніра/);
    });
    await t.test('incomplete pair, revoked permissions, changed article/binding, remote appearance and weight blockers reject completion',async()=>{
      const before=await snapshot();
      await assert.rejects(namesService.previewProductMagentoName({...proposed,subjectEn:''},options),/англійську/);
      await assert.rejects(namesService.previewProductMagentoName(proposed,{...options,mutationContext:{actorUserId:99999999}}),{code:'ADMIN_PERMISSION_REVOKED'});
      await assert.rejects(namesService.previewProductMagentoName({...proposed,article:'OTHER'},options),{code:'MAGENTO_NAME_HISTORICAL_CONTEXT_CHANGED'});
      await assert.rejects(namesService.previewProductMagentoName({...proposed,bindingRevisionId:randomUUID()},options),{code:'MAGENTO_NAME_HISTORICAL_CONTEXT_CHANGED'});
      const local=await namesService.previewProductMagentoName(proposed,options);
      remotePresent=true;await assert.rejects(apply(local),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});remotePresent=false;
      assert.deepEqual(await snapshot(),before);
      await mutate('UPDATE products SET weight=0 WHERE id=$1',[product.id]);
      assert.equal((await historical.preview({skus:[command.article]},options)).items[0].manualNameCompletion,false);
      await assert.rejects(namesService.previewProductMagentoName(proposed,options),{code:'HISTORICAL_MANUAL_NAMES_UNAVAILABLE'});
      await mutate('UPDATE products SET weight=531 WHERE id=$1',[product.id]);
    });
    await t.test('stale local/remote observation, actor, input and expiry reject the reviewed save',async()=>{
      let review=await namesService.previewProductMagentoName(proposed,options);
      remotePresent=true;await assert.rejects(apply(review),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});remotePresent=false;
      await assert.rejects(apply(review,{now:()=>Date.parse(review.reviewExpiresAt)+1}),{code:'HISTORICAL_REVIEW_STALE'});
      await assert.rejects(namesService.applyProductMagentoName({...proposed,subjectEn:'Changed subject',previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt},options),{code:'HISTORICAL_REVIEW_STALE'});
      const other=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Other name reviewer') RETURNING id")).rows[0].id);
      await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[other]);
      await assert.rejects(apply(review,{mutationContext:{actorUserId:other},actorUserId:other}),{code:'HISTORICAL_REVIEW_STALE'});
      review=await namesService.previewProductMagentoName(proposed,options);let count=0;
      onGet=async parsed=>{if(parsed.pathname.endsWith('/products')&&++count===1)await mutate('UPDATE products SET correction_reason=$2 WHERE id=$1',[product.id,'Independent name-review change']);};
      await assert.rejects(apply(review),{code:'HISTORICAL_REVIEW_STALE'});onGet=null;
      assert.equal((await snapshot()).product.magento_name_subject_ua,null);assert.equal((await snapshot()).jobs,null);
    });
    await t.test('prepared form token binds local context and actual reviewed full names; stale purposes, expiry and binding fail before GET',async()=>{
      const form=await namesService.previewProductMagentoName(command,options), generated=await namesService.previewProductMagentoName(proposed,options);
      const prepared={...proposed,preparationToken:form.preparationToken,reviewExpiresAt:form.reviewExpiresAt,reviewedNameUa:generated.nameUa,reviewedNameEn:generated.nameEn};
      const before=await snapshot(), reads=requests.length;
      for(const change of [{reviewedNameEn:'Wrong full name'},{subjectUa:'Changed input'},
        {previewToken:form.preparationToken},{preparationToken:generated.previewToken},{bindingRevisionId:randomUUID()}]) {
        await assert.rejects(namesService.applyProductMagentoName({...prepared,...change},options));
        assert.deepEqual(await snapshot(),before);
      }
      await assert.rejects(namesService.applyProductMagentoName(prepared,{...options,now:()=>Date.parse(form.reviewExpiresAt)+1}),{code:'HISTORICAL_REVIEW_STALE'});
      assert.equal(requests.length,reads);
      await mutate('UPDATE products SET correction_reason=$2 WHERE id=$1',[product.id,'Changed prepared context']);
      await assert.rejects(namesService.applyProductMagentoName(prepared,options),{code:'HISTORICAL_REVIEW_STALE'});
      assert.equal(requests.length,reads);
    });
    await t.test('interrupted target GET releases session locks and preserves the archived pair, request and audit',async()=>{
      const review=await namesService.previewProductMagentoName(proposed,options),before=await snapshot();
      onGet=async()=>{throw new Error('Synthetic interrupted Magento GET');};
      try { await assert.rejects(apply(review),{code:'MAGENTO_NETWORK_ERROR'}); } finally { onGet=null; }
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('audit failure rolls back the subject pair and request while preserving the archive',async()=>{
      const review=await namesService.previewProductMagentoName(proposed,options),before=await snapshot();
      await db.query(`CREATE FUNCTION reject_create_names_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product_magento_name.updated' THEN RAISE EXCEPTION 'CREATE_NAMES_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_create_names_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_create_names_audit()`);
      await assert.rejects(apply(review),/CREATE_NAMES_AUDIT_FAILURE/);
      await db.query('DROP TRIGGER reject_create_names_audit ON audit_events; DROP FUNCTION reject_create_names_audit()');assert.deepEqual(await snapshot(),before);
    });
    await t.test('explicit save persists only the reviewed subjects; fresh normal historical preview becomes eligible CREATE',async()=>{
      const oldList=await historical.preview({skus:[command.article]},options);
      const form=await namesService.previewProductMagentoName(command,options),review=await namesService.previewProductMagentoName(proposed,options),before=await snapshot();
      const saved=await namesService.applyProductMagentoName({...proposed,preparationToken:form.preparationToken,reviewExpiresAt:form.reviewExpiresAt,
        reviewedNameUa:review.nameUa,reviewedNameEn:review.nameEn},options),after=await snapshot();
      await assert.rejects(historical.confirm({skus:oldList.skus,selectedSkus:[command.article],selectedCreateSkus:[command.article],confirmCurrentFactsAndStandardDelivery:true,
        idempotencyKey:randomUUID(),reviewNonce:oldList.reviewNonce,reviewHash:oldList.reviewHash,reviewToken:oldList.reviewToken,reviewExpiresAt:oldList.reviewExpiresAt},options),{code:'HISTORICAL_REVIEW_STALE'});
      assert.equal(saved.state,'archived');assert.equal(saved.subjectsSaved,true);assert.equal(saved.remoteProductId,null);
      assert.equal(after.product.magento_name_subject_ua,pair.subjectUa);assert.equal(after.product.magento_name_subject_en,pair.subjectEn);assert.equal(after.product.magento_name_review_required,false);
      const excluded=new Set(['magento_name_subject_ua','magento_name_subject_en','magento_name_review_required']);
      assert.deepEqual(Object.fromEntries(Object.entries(after.product).filter(([key])=>!excluded.has(key))),Object.fromEntries(Object.entries(before.product).filter(([key])=>!excluded.has(key))));
      assert.deepEqual(after.lifecycle,before.lifecycle);assert.equal(after.product.status,'archived');assert.equal(after.lifecycle.route,'retired');
      assert.equal(after.request.state,'needs_attention');assert.equal(after.request.reason_code,'product_retired');assert.equal(after.jobs,null);assert.equal(after.intents,0);assert.equal(after.names,null);
      await assert.rejects(apply(review),{code:'HISTORICAL_REVIEW_STALE'});
      const reread=await namesService.previewProductMagentoName(command,options);assert.equal(reread.alreadyCompleted,true);assert.equal(reread.subjectUa,pair.subjectUa);
      const fresh=(await historical.preview({skus:[command.article]},options)).items[0];assert.equal(fresh.disposition,'eligible');assert.equal(fresh.deliveryMode,'create');assert.equal(fresh.targetStatus,2);assert.equal(fresh.currentName,review.nameUa);
      assert.deepEqual(fresh.deliveryBlockerCodes,[]);assert.equal((await snapshot()).product.status,'archived');
      assert.equal((await db.query("SELECT id FROM magento_binding_revisions WHERE state='published'")).rows[0].id,published.id);
    });
    await t.test('final full-list confirmation detects another product changing and freshly checks remote absence',async()=>{
      const list=await historical.preview({skus:[command.article,'SV2314004']},options);
      const confirmation={skus:list.skus,selectedSkus:[command.article],selectedCreateSkus:[command.article],confirmCurrentFactsAndStandardDelivery:true,idempotencyKey:randomUUID(),
        reviewNonce:list.reviewNonce,reviewHash:list.reviewHash,reviewToken:list.reviewToken,reviewExpiresAt:list.reviewExpiresAt};
      await mutate('UPDATE products SET total_price_uah=24001 WHERE id=$1',[other.id]);
      const schemaBefore=schemaPasses;
      await assert.rejects(historical.confirm(confirmation,options),{code:'HISTORICAL_REVIEW_STALE'});
      assert.equal(schemaPasses,schemaBefore+1);assert.equal((await snapshot()).intents,0);
      await mutate('UPDATE products SET total_price_uah=24000 WHERE id=$1',[other.id]);
      remotePresent=true;await assert.rejects(historical.confirm({...confirmation,idempotencyKey:randomUUID()},options),{code:'HISTORICAL_REVIEW_STALE'});remotePresent=false;
      await assert.rejects(historical.confirm({...confirmation,idempotencyKey:randomUUID()},{...options,now:()=>Date.parse(list.reviewExpiresAt)+1}));
      assert.equal((await snapshot()).intents,0);assert.equal((await snapshot()).jobs,null);
    });
    await t.test('reconciliation-required and successor history remain closed for manual completion',async()=>{
      await db.query("UPDATE magento_product_sync_requests SET reason_code='reconciliation_required' WHERE product_id=$1",[product.id]);
      await assert.rejects(namesService.previewProductMagentoName(command,options),{code:'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED'});
      await db.query("UPDATE magento_product_sync_requests SET reason_code='product_retired' WHERE product_id=$1",[product.id]);
      await authorized(client=>insertNativeProductFixture(client,{category:'SV',totalPriceUah:25000,weight:531,correctedFromProductId:product.id}));
      await assert.rejects(namesService.previewProductMagentoName(command,options),{code:'HISTORICAL_LINEAGE_BLOCKED'});
    });
  } finally {
    await db?.end();await appPool?.end();
    if(created)await control.query(`DROP DATABASE ${name}`);
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),expected);await control.end();
  }
});
