const {test,assert,Pool,runNodeInDatabase,recreateTestDatabase,dropTestDatabase}=require('./suite-context');
const {insertProductFixture}=require('./product-fixture');
const templates=require('../src/services/export-templates/template.service');
const bindings=require('../src/services/magento/binding.service');
const publication=require('../src/services/magento/binding-publication');
const handoff=require('../src/services/magento/binding-handoff');
const controlled=require('../src/services/magento/binding-controlled-actions');
const categoryWorkspace=require('../src/services/magento/integration-category-workspace');
const fixture=require('../test/fixtures/magento-v4');
const {REQUIRED}=require('../src/services/export-templates/column-contract');
const {readPreviewProduct}=require('../src/services/magento/sync-preview-db');
const {evaluate}=require('../src/services/magento/binding-evidence-products');
const {createAutomaticSyncWorker}=require('../src/services/magento/automatic-sync-worker');
test('H3b full scope exceeds historical 1000 without truncation and detects last-page lifecycle drift',async()=>{
  const name='amber_publication_scope_test',f=await setup(name);
  try{
    const added=await insertProductFixture(f.db,`INSERT INTO products(full_sku,category,weight,total_price_uah,details)
      SELECT 'XG-SCALE-'||n,'XG',5,42,'{"answers":{}}' FROM generate_series(1,1001) n RETURNING id`);
    await f.db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=ANY($1::int[])",[added.rows.map(p=>p.id)]);
    const definition=structuredClone(f.d);definition.groups[0].rows[0].cells.price.value='43';
    const draft=await f.draft(definition,'scale-next'),input={bindingRevisionId:draft.id,expectedRevision:draft.revision,expectedCurrentId:f.current.id};
    const reviewed=await publication.preview(f.config,input,f.options);assert.equal(reviewed.totalProducts,1004);assert.equal(reviewed.affected.length,1003);
    await f.db.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=(SELECT max(id) FROM products)");
    const next=await publication.preview(f.config,input,f.options);assert.notEqual(next.previewToken,reviewed.previewToken);
    await assert.rejects(publication.publish(f.config,{...input,previewToken:reviewed.previewToken},f.options),{code:'MAGENTO_PUBLICATION_STALE'});
    assert.equal((await f.db.query("SELECT state FROM magento_binding_revisions WHERE id=$1",[draft.id])).rows[0].state,'draft');
    const fresh=await publication.preview(f.config,input,f.options);
    const receipt=await publication.publish(f.config,{...input,previewToken:fresh.previewToken,ackCoverageLoss:true,coverageReason:'Reviewed exact synthetic exclusion loss'},f.options);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_binding_handoff_items WHERE handoff_id=$1',[receipt.handoffId])).rows[0].n,1002);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
async function setup(name){
  const url=await recreateTestDatabase(name),db=new Pool({connectionString:url});
  await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
  const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Publication admin') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
  const options={databasePool:db,mutationContext:{actorUserId:actor}};
  await db.query("INSERT INTO categories(code,name) VALUES('XG','Changed'),('YG','Unchanged')");
  const d=fixture.definition(['XG','YG']);d.sources={sku:d.sources.sku};d.tables={};d.questionContracts={};
  for(const g of d.groups){g.columns=[...REQUIRED];for(const r of g.rows){delete r.cells.kolir;delete r.cells.new_note;r.cells.price={op:'literal',value:r.id==='base'?'42':''};}}
  const observed=fixture.observation();observed.attributes.find((a)=>a.attribute_code==='name').scope='store';
  const schema=require('../src/services/magento/binding-contract').normalizeSchema(observed);
  const approved=(definition)=>{
    const b=fixture.approvedBindings(definition,schema);
    for(const a of b.attributes)if(a.transportTarget)a.transportTarget='product.'+({attribute_set_code:'attribute_set_id',product_type:'type_id'}[a.target] || a.target);
    for(const p of b.policies){const a=b.attributes.find((a)=>a.bindingKey===p.bindingKey);p.policy=['name','price'].includes(a.target)?'authoritative_create_update':a.rowId==='english'?'magento_managed':'initialize_create_only';}
    return b;
  };
  const config={configured:true,baseUrl:'https://publication.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
  async function version(definition,key){const f=await templates.createTemplate({key,displayName:key,definition},options);return templates.publishTemplate(f.id,{expectedRevision:f.draft.revision,expectedDefinitionHash:f.draft.definitionHash},options);}
  async function draft(definition,key){const v=await version(definition,key);let b=await bindings.createDraft({installationKey:'publication',origin:config.baseUrl,templateVersionId:v.id,observedAt:'2026-10-02T00:00:00.000Z',schema},options);
    return bindings.updateDraft(b.id,{expectedRevision:b.revision,bindings:approved(definition)},options);}
  const initial=await draft(d,'initial'),current=await bindings.publishDraft(initial.id,{expectedRevision:initial.revision,expectedCurrentId:null},options);
  const products=[];
  for(const [index,category] of ['XG','YG','XG'].entries()){
    const p=(await insertProductFixture(db,"INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,$2,5,42,'{\"answers\":{}}') RETURNING *",[category+'00'+index,category])).rows[0];products.push(p);
    await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]);
    const names={all:'Тестова назва',en:'Test name'};
    await db.query(`INSERT INTO magento_name_sync_states(origin_hash,public_product_identity_id,remote_product_id,baseline_names,observed_amber_names,observed_remote_names,state)
      VALUES($1,$2,$3,$4::jsonb,$4::jsonb,$4::jsonb,'common')`,[current.originHash,p.public_product_identity_id,10000+Number(p.id),JSON.stringify(names)]);
    await db.query("INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,desired_generation,synced_generation,state) VALUES($1,$2,1,1,'synced')",[p.public_product_identity_id,p.id]);
  }
  await db.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='publication',actor_user_id=$1 WHERE singleton",[actor]);
  const raw=new Map(products.map((p)=>[p.full_sku,{id:10000+Number(p.id),sku:p.full_sku,attribute_set_id:8001,type_id:'simple',status:2,visibility:4,price:42,name:'Тестова назва',custom_attributes:[],extension_attributes:{category_links:[],website_ids:[]}}]));
  const english=new Map(products.map((p)=>[p.full_sku,'Test name']));const calls=[];
  const fetchImpl=async(url,init)=>{
    assert.equal(init.method,'GET');calls.push(String(url));const u=new URL(url);let result;
    if(u.pathname.endsWith('/categories'))result={id:803,parent_id:0,name:'Default',children_data:[]};
    else if(u.pathname.endsWith('/products')){const sku=u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');const p=raw.get(sku);
      assert.ok(p,'exact synthetic SKU');result={items:[{...p,...(u.pathname.includes('/rest/en/')?{name:english.get(sku)}:{})}],total_count:1};}
    else throw new Error('Unexpected fixture GET: '+u.pathname);
    return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const discover=async()=>({schema,categories:[],observedAt:'2026-10-02T00:00:00.000Z'});
  return {url,db,actor,options:{...options,fetchImpl,discover},config,d,schema,approved,current,products,draft,raw,english,calls};
}

test('category workspace reads the exact immutable publication without product checks or writes; name candidates stay in category',async()=>{
  const name='amber_category_workspace_test',f=await setup(name);
  try{
    const original=await bindings.getRevision(f.current.id,f.options);
    const counts=async()=> (await f.db.query(`SELECT
      (SELECT count(*)::int FROM magento_binding_revisions) AS revisions,
      (SELECT count(*)::int FROM export_template_versions) AS versions,
      (SELECT count(*)::int FROM audit_events) AS audits,
      (SELECT count(*)::int FROM magento_sync_jobs) AS jobs`)).rows[0];
    const before=await counts();
    const result=await categoryWorkspace.readCategory(f.config,'XG',{bindingRevisionId:f.current.id},f.options);
    assert.equal(result.revision.id,f.current.id);assert.equal(result.template.versionId,f.current.templateVersionId);
    assert.equal(result.attributes.find(a=>a.code==='kolir').state,'unmapped');
    assert.equal(result.attributes.find(a=>a.code==='name').state,'connected');
    const english=await categoryWorkspace.readField(f.config,'XG','name',{bindingRevisionId:f.current.id,rowId:'english'},f.options);
    assert.ok(english.entries.length);assert.ok(english.entries.every(e=>e.group==='XG'&&e.row==='english'));
    const picker=await controlled.candidates(f.config,f.current.id,f.options,{categoryCode:'XG'});
    assert.deepEqual(picker.products.map(p=>p.productId),[f.products[0].id,f.products[2].id]);
    assert.equal(f.calls.length,0);assert.deepEqual(await counts(),before);
    assert.deepEqual(await bindings.getRevision(f.current.id,f.options),original);
  }finally{await f.db.end();await dropTestDatabase(name);}
});

test('publication lifecycle race uses independent connections: committed drift is stale and locked state waits for commit',async()=>{
  for(const order of ['before','after']){
    const name=`amber_publication_lifecycle_${order}_test`,f=await setup(name),writer=await f.db.connect();
    try{
      const draft=await f.draft(f.d,'race-next'),input={bindingRevisionId:draft.id,expectedRevision:draft.revision,expectedCurrentId:f.current.id};
      const proof=await publication.preview(f.config,input,f.options);
      let arrived,release;const atLock=new Promise(r=>{arrived=r;}),resume=new Promise(r=>{release=r;});
      const boundaryPool={query:(...a)=>f.db.query(...a),connect:async()=>{
        const client=await f.db.connect();return {release:()=>client.release(),query:async(...a)=>{
          if(typeof a[0]==='string' && a[0].startsWith('LOCK TABLE categories')){
            if(order==='before'){arrived();await resume;}
            const result=await client.query(...a);
            if(order==='after'){arrived();await resume;}return result;
          }return client.query(...a);
        }};
      }};
      // Attach rejection handling immediately while the final boundary is paused.
      const applying=publication.publish(f.config,{...input,previewToken:proof.previewToken},{...f.options,databasePool:boundaryPool})
        .then(value=>({value}),error=>({error}));
      await atLock;
      await writer.query('BEGIN');const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const changing=writer.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1",[f.products[0].id]);
      if(order==='before'){await changing;await writer.query('COMMIT');release();const result=await applying;
        assert.equal(result.error?.code,'MAGENTO_PUBLICATION_STALE');
        assert.equal((await f.db.query('SELECT state FROM magento_binding_revisions WHERE id=$1',[draft.id])).rows[0].state,'draft');
      }else{
        let blocked=false;
        for(let i=0;i<100 && !blocked;i++){
          blocked=(await f.db.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
          if(!blocked)await new Promise(r=>setTimeout(r,10));
        }
        assert.ok(blocked,'independent lifecycle writer really waits on publication locks');release();
        const result=await applying;assert.ok(result.value,!result.error && 'publication commits its coherent reviewed state');
        await changing;await writer.query('COMMIT');
      }
      assert.equal((await f.db.query('SELECT business_exclusion_state FROM product_full_export_state WHERE product_id=$1',[f.products[0].id])).rows[0].business_exclusion_state,'excluded');
    }finally{await writer.query('ROLLBACK');writer.release();await f.db.end();await dropTestDatabase(name);}
  }
});
test('H3b publication: exact minimal handoff, immutable name pins, restart/concurrent enrollment and verified shared-name delivery',async()=>{
  const name='amber_publication_handoff_test',f=await setup(name);
  try{
    const next=structuredClone(f.d);next.groups[0].rows[0].cells.price.value='43';next.groups[0].rows[0].cells.name.value='Нова назва';next.groups[0].rows[1].cells.name.value='New name';
    const draft=await f.draft(next,'next'),input={bindingRevisionId:draft.id,expectedRevision:draft.revision,expectedCurrentId:f.current.id};
    const original=await bindings.getRevision(f.current.id,f.options),baseline=(await f.db.query('SELECT * FROM magento_name_sync_states ORDER BY public_product_identity_id')).rows;
    const preview=await publication.preview(f.config,input,{...f.options,internal:true});
    assert.equal(preview.internal.proof.projections[0].before.covered,true,JSON.stringify(preview.internal.proof.projections));
    assert.equal(preview.blockers.length,0,JSON.stringify({blockers:preview.blockers,checked:preview.checked}));assert.deepEqual(preview.affected.map((p)=>p.productId),[f.products[0].id,f.products[2].id]);
    assert.equal(preview.preservedNames.length,2);assert.ok(f.calls.length);assert.equal(preview.checked.length,1);
    await f.db.query("UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='reconciliation_required' WHERE product_id=$1",[f.products[2].id]);
    const second=new Pool({connectionString:f.url});
    let receipt;
    try{
      const race=await Promise.all([publication.publish(f.config,{...input,previewToken:preview.previewToken},f.options),
        publication.publish(f.config,{...input,previewToken:preview.previewToken},{...f.options,databasePool:second})]);
      receipt=race[0];assert.equal(race[0].handoffId,race[1].handoffId);assert.equal(race.filter((r)=>!r.alreadyApplied).length,1);
      const enrollment=await Promise.all([handoff.processHandoffs(f.config,f.options),handoff.processHandoffs(f.config,{databasePool:second})]);
      assert.equal(enrollment.reduce((sum,r)=>sum+r.settled,0),2);
    }finally{await second.end();}
    assert.deepEqual(await bindings.getRevision(f.current.id,f.options),original);
    assert.deepEqual((await f.db.query('SELECT * FROM magento_name_sync_states ORDER BY public_product_identity_id')).rows,baseline);
    const requests=(await f.db.query('SELECT * FROM magento_product_sync_requests ORDER BY product_id')).rows;
    assert.equal(requests[0].desired_generation,'2');assert.equal(requests[1].desired_generation,'1');assert.equal(requests[2].desired_generation,'1');
    assert.equal(requests[2].reason_code,'reconciliation_required');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
    const read=await readPreviewProduct(f.db,{productId:f.products[0].id,bindingRevisionId:receipt.revision.id});assert.equal(evaluate(read,read.product).base.name,'Тестова назва');
    await assert.rejects(f.db.query("UPDATE magento_binding_name_pins SET effective_names='{}'"),/immutable/);
    await assert.rejects(f.db.query("UPDATE magento_binding_handoff_items SET state='pending',generation=NULL WHERE state='enrolled'"),/immutable/);
    const status=await handoff.status(f.config,receipt.revision.id,f.options);assert.equal(status[0].protected,1);assert.equal(status[0].waiting,1);
    const action={bindingRevisionId:receipt.revision.id,expectedRevision:receipt.revision.revision,kind:'name_rule',productIds:[f.products[0].id],reason:'Explicit reviewed rule application'};
    const namePreview=await controlled.preview(f.config,action,f.options);assert.equal(namePreview.products[0].after.all,'Нова назва');assert.equal(namePreview.products[0].before.all,'Тестова назва');
    await controlled.apply(f.config,{...action,previewToken:namePreview.previewToken},f.options);
    assert.equal((await f.db.query('SELECT magento_name_override FROM products WHERE id=$1',[f.products[0].id])).rows[0].magento_name_override.values.all,'Нова назва');
    const freshRead=await readPreviewProduct(f.db,{productId:f.products[0].id,bindingRevisionId:receipt.revision.id});assert.equal(evaluate(freshRead,freshRead.product).base.name,'Нова назва');
    const worker=createAutomaticSyncWorker(f.config,{databasePool:f.db,jobOptions:{fetchImpl:f.options.fetchImpl,
      preview:(config,options)=>require('../src/services/magento/sync-preview').previewProduct(config,{...options,discover:async()=>f.schema}),
      dispatch:async(config,operation)=>{const product=f.raw.get(operation.payload.product.sku);if(operation.domain==='storeViews')f.english.set(product.sku,operation.payload.product.name);
        else if(operation.domain==='coreProduct'){Object.assign(product,operation.payload.product);product.id=10000+Number(f.products[0].id);}else throw new Error('Unexpected domain');}}});
    await worker.runProduct(f.products[0].public_product_identity_id);
    const final=(await f.db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[f.products[0].id])).rows[0];
    assert.equal(final.state,'synced');assert.equal(final.desired_generation,final.synced_generation);
    const common=(await f.db.query('SELECT baseline_names FROM magento_name_sync_states WHERE public_product_identity_id=$1',[f.products[0].public_product_identity_id])).rows[0];
    assert.deepEqual(common.baseline_names,{all:'Нова назва',en:'New name'});
    assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_sync_steps WHERE state='verified'")).rows[0].n,2);
    await worker.stop();
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('H3b coverage loss needs exact Administrator acknowledgement; stale evidence and conflict rule application fail closed',async()=>{
  const name='amber_publication_loss_test',f=await setup(name);
  try{
    let draft=await bindings.clonePublished(f.current.id,{expectedRevision:f.current.revision},f.options);
    const b=structuredClone(draft.bindings);b.routes.find((r)=>r.routeKey==='YG:all').enabled=false;
    draft=await bindings.updateDraft(draft.id,{expectedRevision:draft.revision,bindings:b},f.options);
    const input={bindingRevisionId:draft.id,expectedRevision:draft.revision,expectedCurrentId:f.current.id},proof=await publication.preview(f.config,input,f.options);
    assert.deepEqual(proof.lostRoutes,['YG:all']);assert.deepEqual(proof.lostProducts.map((p)=>p.productId),[f.products[1].id]);
    await assert.rejects(publication.publish(f.config,{...input,previewToken:proof.previewToken},f.options),{code:'MAGENTO_COVERAGE_ACK_REQUIRED'});
    const publisher=(await f.db.query("INSERT INTO application_users(status,display_name) VALUES('active','Custom publisher') RETURNING id")).rows[0].id;
    const role=(await f.db.query("INSERT INTO roles(role_key,display_name,description) VALUES('test_publisher','Publisher','Test only') RETURNING id")).rows[0].id;
    await f.db.query("INSERT INTO role_permissions(role_id,permission_key) SELECT $1,unnest($2::text[])",[role,['export_templates.manage','export_templates.publish','exports.view']]);
    await f.db.query('INSERT INTO user_role_assignments(application_user_id,role_id) VALUES($1,$2)',[publisher,role]);
    await assert.rejects(publication.publish(f.config,{...input,previewToken:proof.previewToken,ackCoverageLoss:true,coverageReason:'Reviewed loss'},
      {...f.options,mutationContext:{actorUserId:Number(publisher)}}),{code:'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED'});
    await f.db.query('UPDATE products SET total_price_uah=44 WHERE id=$1',[f.products[0].id]);
    await assert.rejects(publication.publish(f.config,{...input,previewToken:proof.previewToken,ackCoverageLoss:true,coverageReason:'Intentional reviewed loss'},f.options),{code:'MAGENTO_PUBLICATION_STALE'});
    const current=await publication.preview(f.config,input,f.options);
    const receipt=await publication.publish(f.config,{...input,previewToken:current.previewToken,ackCoverageLoss:true,coverageReason:'Intentional reviewed loss'},f.options);
    assert.equal((await handoff.status(f.config,receipt.revision.id,f.options))[0].total,0);
    const action={bindingRevisionId:receipt.revision.id,expectedRevision:receipt.revision.revision,kind:'name_rule',productIds:[f.products[0].id],reason:'Reviewed rule'};
    await f.db.query("UPDATE magento_name_sync_states SET state='conflict',version=version+1 WHERE public_product_identity_id=$1",[f.products[0].public_product_identity_id]);
    const conflict=await controlled.preview(f.config,action,f.options);assert.equal(conflict.blockers[0].code,'NAME_CONFLICT_OR_BASELINE_REQUIRED');
    await assert.rejects(controlled.apply(f.config,{...action,previewToken:conflict.previewToken},f.options),{code:'MAGENTO_CONTROLLED_ACTION_STALE'});
    const resync={...action,kind:'broader_resync',productIds:[f.products[1].id]};
    const reviewed=await controlled.preview(f.config,resync,f.options);
    await assert.rejects(controlled.apply(f.config,{...resync,previewToken:reviewed.previewToken},
      {...f.options,mutationContext:{actorUserId:Number(publisher)}}),{code:'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED'});
    assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_binding_handoffs WHERE kind='broader_resync'")).rows[0].n,0);
    await controlled.apply(f.config,{...resync,previewToken:reviewed.previewToken},f.options);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_binding_handoffs WHERE kind='broader_resync'")).rows[0].n,1);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('H3b new route requires a representative CREATE; changed common-name evidence invalidates publication review',async()=>{
  const name='amber_publication_create_test',f=await setup(name);
  try{
    await f.db.query("INSERT INTO categories(code,name) VALUES('ZG','New group')");
    const next=structuredClone(f.d);next.groups.push({...structuredClone(next.groups[0]),route:'ZG',name:'New group'});
    const draft=await f.draft(next,'new-route'),input={bindingRevisionId:draft.id,expectedRevision:draft.revision,expectedCurrentId:f.current.id};
    const missing=await publication.preview(f.config,input,f.options);assert.deepEqual(missing.blockers,[{code:'REPRESENTATIVE_CREATE_REQUIRED',routeKey:'ZG:all'}]);
    await assert.rejects(publication.publish(f.config,{...input,previewToken:missing.previewToken},f.options),{code:'MAGENTO_PUBLICATION_STALE'});
    const request={...input,representatives:[{product:{categoryCode:'ZG',answers:{},weight:'5'}}]},createPreview=async(config,input)=>{
      assert.equal(input.product.categoryCode,'ZG');return {sendable:true,routeKey:'ZG:all',blockers:[],mode:'create'};
    },options={...f.options,createPreview};
    const proof=await publication.preview(f.config,request,options);assert.equal(proof.blockers.length,0);
    await f.db.query('UPDATE magento_name_sync_states SET version=version+1 WHERE public_product_identity_id=$1',[f.products[0].public_product_identity_id]);
    await assert.rejects(publication.publish(f.config,{...request,previewToken:proof.previewToken},options),{code:'MAGENTO_PUBLICATION_STALE'});
    assert.equal((await bindings.getRevision(draft.id,f.options)).state,'draft');
    const fresh=await publication.preview(f.config,request,options);await publication.publish(f.config,{...request,previewToken:fresh.previewToken},options);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM products')).rows[0].n,3);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
    const candidates=await controlled.candidates(f.config,draft.id,f.options);assert.equal(candidates.products.length,3);assert.equal(candidates.nextCursor,null);
    await runNodeInDatabase(f.url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    assert.equal((await f.db.query("SELECT count(*)::int n FROM schema_migrations WHERE name='055_magento_publication_handoff.sql'")).rows[0].n,1);
  }finally{await f.db.end();await dropTestDatabase(name);}
});

module.exports={setup};
