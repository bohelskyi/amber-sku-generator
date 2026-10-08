const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');

test('archived SV equivalent comma weight is reviewed and normalized without activation or delivery', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_archived_weight_${process.pid}_${randomBytes(6).toString('hex')}_test`;
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
    await db.query("INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type) VALUES('SV','weight','Weight',2,0,1,'text')");
    const { insertProductFixture, insertNativeProductFixture } = require('./product-fixture');
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details)
      VALUES('SV2314004','SV',25000,517,'archived',1,'{"answers":{"souvenir":"4","weight":"517,0","size":"20/8/22"},"manualPriceUah":25000,"logMessage":"unknown prior archive"}') RETURNING *`)).rows[0];
    const other=(await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details,
        magento_name_subject_ua,magento_name_subject_en) VALUES('SV2314005','SV',24000,500,'archived',1,'{"answers":{"souvenir":"4","weight":500}}','Другий тест','Second test') RETURNING *`)).rows[0];
    const config = { configured: true, baseUrl: 'https://create-names.invalid', consumerKey: 'create-names-consumer-unique', consumerSecret: 'create-names-secret-unique', accessToken: 'create-names-access-unique', accessTokenSecret: 'create-names-access-secret-unique' };
    const options = { databasePool: db, config, reviewSecret: 'synthetic-archived-name-review-secret', actorUserId: actor, mutationContext: { actorUserId: actor, requestId: 'create-names-fixture' } };
    const fixture = require('../test/fixtures/magento-bindings'); const definition = structuredClone(fixture.definition());
    const actual = require('../src/services/export-templates/magento-v1-definition').materializeMagentoV1(new Map(), { publicSku: true });
    definition.sources = { sku: definition.sources.sku, price: { kind: 'product', field: 'total_price_uah', type: 'scalar' },
      ...Object.fromEntries(['public_sku','magento_name_subject_ua','magento_name_subject_en','SV.souvenir','SV.weight'].map(key => [key, actual.sources[key]])) };
    definition.evaluatorVersion = actual.evaluatorVersion; definition.sourceContractVersion = actual.sourceContractVersion;
    definition.tables = {};
    definition.bindings = actual.bindings.filter(b => b.id === 'sku' || b.id === 'SV.decor_weight' || /^SV\.(manual|automatic|name)/.test(b.id));
    definition.groups.find(g => g.route === 'SV').evaluate = [{ op:'ref', id:'SV.nameCheck' }, { op:'ref', id:'SV.decor_weight' }];
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
      const present=remotePresent && parsed.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]')==='SV2314004';
      if(onGet) await onGet(parsed);
      let value;
      if(parsed.pathname.endsWith('/categories'))value={id:803,parent_id:1,name:'Default',children_data:[]};
      else { assert.ok(parsed.pathname.endsWith('/products'));value={items:present?[{id:900001,sku:'SV2314004',attribute_set_id:8001,name:'Unexpected remote',price:25000,status:2,visibility:4,type_id:'simple',custom_attributes:[],extension_attributes:{category_links:[],website_ids:[801]}}]:[],total_count:present?1:0}; }
      return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    };
    let schemaPasses=0;
    options.discover=async()=>{schemaPasses++;return schema;};
    const historical=require('../src/services/historical-standard-reactivation.service');
    const service=require('../src/services/magento/historical-sv-weight-normalization.service');
    const command={productId:Number(product.id),article:'SV2314004',bindingRevisionId:published.id};
    const apply=review=>service.apply({...command,previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt,confirmEquivalentWeightNormalization:true},options);
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

    await t.test('historical preview offers the exact comma arrow while manual names remain blocked; repair preview is local and read-only',async()=>{
      const before=await snapshot(), list=await historical.preview({skus:[command.article]},options);
      assert.deepEqual(list.items[0].weightNormalization,{sourceWeight:'517,0',targetWeight:'517.0',canonicalWeight:'517.000'});
      assert.equal(list.items[0].manualNameCompletion,false);
      const reads=requests.length, review=await service.preview(command,options);
      assert.equal(review.sourceWeight,'517,0');assert.equal(review.targetWeight,'517.0');assert.equal(review.canonicalWeight,'517.000');
      assert.equal(review.state,'archived');assert.equal(review.alreadyCompleted,false);assert.match(review.previewToken,/^[a-f0-9]{64}$/);
      assert.ok(review.remainingIssues.every(i=>i.code==='manual_name_required' && i.field==='name'));
      assert.equal(requests.length,reads);assert.deepEqual(await snapshot(),before);
    });
    await t.test('missing explicit consent and wrong identity, actor or expired evidence never write',async()=>{
      const before=await snapshot(),review=await service.preview(command,options),reads=requests.length;
      await assert.rejects(service.apply({...command,previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt},options),{code:'HISTORICAL_WEIGHT_CONFIRMATION_REQUIRED'});
      await assert.rejects(service.preview({...command,article:'OTHER'},options));
      await assert.rejects(service.preview(command,{...options,actorUserId:99999999,mutationContext:{actorUserId:99999999}}),{code:'ADMIN_PERMISSION_REVOKED'});
      await assert.rejects(service.apply({...command,previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt,confirmEquivalentWeightNormalization:true},{...options,now:()=>Date.parse(review.reviewExpiresAt)+1}),{code:'HISTORICAL_REVIEW_STALE'});
      assert.equal(requests.length,reads);assert.deepEqual(await snapshot(),before);
    });
    await t.test('different, missing, ambiguous and rounded-equal answers or canonical weights stay blocked',async()=>{
      for(const raw of ['',null,517,'518,0','517,0,0','517,0 g','517,000000000000000001']){
        await mutate("UPDATE products SET details=jsonb_set(details,'{answers,weight}',$2::jsonb,false) WHERE id=$1",[product.id,JSON.stringify(raw)]);
        const before=await snapshot();await assert.rejects(service.preview(command,options),{code:'HISTORICAL_WEIGHT_NORMALIZATION_UNAVAILABLE'});assert.deepEqual(await snapshot(),before);
      }
      await mutate("UPDATE products SET details=jsonb_set(details,'{answers,weight}','\"517,0\"'::jsonb,false) WHERE id=$1",[product.id]);
      await mutate('UPDATE products SET weight=0 WHERE id=$1',[product.id]);
      await assert.rejects(service.preview(command,options),{code:'HISTORICAL_WEIGHT_NORMALIZATION_UNAVAILABLE'});
      await mutate('UPDATE products SET weight=518 WHERE id=$1',[product.id]);
      await assert.rejects(service.preview(command,options),{code:'HISTORICAL_WEIGHT_NORMALIZATION_UNAVAILABLE'});
      await mutate('UPDATE products SET weight=517 WHERE id=$1',[product.id]);
    });
    await t.test('stale complete product, metadata, binding, request and actor invalidate the exact signed repair',async()=>{
      let review=await service.preview(command,options);
      await mutate('UPDATE products SET correction_reason=$2 WHERE id=$1',[product.id,'Independent preserved change']);
      await assert.rejects(apply(review),{code:'HISTORICAL_REVIEW_STALE'});
      review=await service.preview(command,options);
      await mutate("UPDATE questions SET label='Weight changed' WHERE category_code='SV' AND key='weight'");
      await assert.rejects(apply(review),{code:'HISTORICAL_REVIEW_STALE'});
      await mutate("UPDATE questions SET label='Weight' WHERE category_code='SV' AND key='weight'");
      review=await service.preview(command,options);
      await assert.rejects(service.apply({...command,bindingRevisionId:randomUUID(),previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt,confirmEquivalentWeightNormalization:true},options));
      await db.query("UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1 WHERE product_id=$1",[product.id]);
      await assert.rejects(apply(review),{code:'HISTORICAL_REVIEW_STALE'});
      const reviewer=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Other weight reviewer') RETURNING id")).rows[0].id);
      await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[reviewer]);
      review=await service.preview(command,options);
      await assert.rejects(service.apply({...command,previewToken:review.previewToken,reviewExpiresAt:review.reviewExpiresAt,confirmEquivalentWeightNormalization:true},{...options,actorUserId:reviewer,mutationContext:{actorUserId:reviewer}}),{code:'HISTORICAL_REVIEW_STALE'});
      const before=await snapshot();await db.query("UPDATE application_users SET status='disabled' WHERE id=$1",[actor]);
      await assert.rejects(apply(review),{code:'ADMIN_PERMISSION_REVOKED'});
      await db.query("UPDATE application_users SET status='active' WHERE id=$1",[actor]);assert.deepEqual(await snapshot(),before);
    });
    await t.test('reconciliation and independent business exclusion cannot be released by format repair',async()=>{
      await db.query("UPDATE magento_product_sync_requests SET reason_code='reconciliation_required' WHERE product_id=$1",[product.id]);
      await assert.rejects(service.preview(command,options),{code:'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED'});
      await db.query("UPDATE magento_product_sync_requests SET reason_code='product_retired' WHERE product_id=$1",[product.id]);
      await authorized(async client=>{await client.query("SET LOCAL amber.lifecycle_maintenance='on'");
        await client.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1",[product.id]);});
      await assert.rejects(service.preview(command,options),{code:'HISTORICAL_BUSINESS_EXCLUSION_REVIEW_REQUIRED'});
      await authorized(async client=>{await client.query("SET LOCAL amber.lifecycle_maintenance='on'");
        await client.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[product.id]);});
    });
    await t.test('audit failure rolls back normalization and triggered request changes',async()=>{
      const review=await service.preview(command,options),before=await snapshot();
      await db.query(`CREATE FUNCTION reject_weight_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.sv_weight_representation_repaired' THEN RAISE EXCEPTION 'WEIGHT_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_weight_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_weight_audit()`);
      try {await assert.rejects(apply(review),/WEIGHT_AUDIT_FAILURE/);}finally{await db.query('DROP TRIGGER reject_weight_audit ON audit_events; DROP FUNCTION reject_weight_audit()');}
      assert.deepEqual(await snapshot(),before);
    });
    await t.test('two independent reviewed apply connections persist only one normalization and one audit; retries are read-only',async()=>{
      const oldList=await historical.preview({skus:[command.article,'SV2314005']},options);
      const review=await service.preview(command,options),before=await snapshot(),reads=requests.length;
      const results=await Promise.allSettled([apply(review),apply(review)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
      const saved=results.find(r=>r.status==='fulfilled').value,after=await snapshot();
      assert.equal(saved.weightNormalized,true);assert.equal(saved.sourceWeight,'517,0');assert.equal(saved.targetWeight,'517.0');
      assert.deepEqual(after.product,require('../src/services/sv-readiness-repair').targetProduct(before.product));
      assert.deepEqual(after.lifecycle,before.lifecycle);assert.equal(after.product.status,'archived');assert.equal(after.product.weight,before.product.weight);assert.equal(after.product.weight,517);
      assert.equal(after.product.total_price_uah,before.product.total_price_uah);assert.equal(after.product.total_price_uah,25000);assert.equal(after.product.details.manualPriceUah,25000);assert.equal(after.product.exclude_from_export,1);
      assert.equal(after.request.state,'needs_attention');assert.equal(after.request.reason_code,'product_retired');assert.equal(after.jobs,null);assert.equal(after.intents,0);assert.equal(after.names,null);
      assert.equal(after.audits,before.audits+1);assert.equal(requests.length,reads);
      await assert.rejects(apply(review),{code:'HISTORICAL_REVIEW_STALE'});
      const reread=await service.preview(command,options);assert.equal(reread.alreadyCompleted,true);assert.equal(reread.sourceWeight,'517.0');assert.equal(reread.previewToken,undefined);
      assert.deepEqual(await snapshot(),after);
      await assert.rejects(historical.confirm({skus:oldList.skus,selectedSkus:['SV2314005'],selectedCreateSkus:['SV2314005'],confirmCurrentFactsAndStandardDelivery:true,
        idempotencyKey:randomUUID(),reviewNonce:oldList.reviewNonce,reviewHash:oldList.reviewHash,reviewToken:oldList.reviewToken,reviewExpiresAt:oldList.reviewExpiresAt},options),{code:'HISTORICAL_REVIEW_STALE'});
      const fresh=(await historical.preview({skus:[command.article]},options)).items[0];assert.equal(fresh.weightNormalization,undefined);assert.equal(fresh.manualNameCompletion,true);
      assert.equal((await snapshot()).product.magento_name_subject_ua,null);assert.equal((await snapshot()).jobs,null);
    });
    await t.test('successor lineage remains closed after a compatible normalized answer',async()=>{
      await authorized(client=>insertNativeProductFixture(client,{category:'SV',totalPriceUah:25000,weight:517,correctedFromProductId:product.id}));
      await assert.rejects(service.preview(command,options),{code:'HISTORICAL_LINEAGE_BLOCKED'});
    });
  } finally {
    await db?.end();await appPool?.end();
    if(created)await control.query(`DROP DATABASE ${name}`);
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),expected);await control.end();
  }
});
