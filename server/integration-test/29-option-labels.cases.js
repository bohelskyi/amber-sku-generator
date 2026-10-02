const {test,assert,Pool,fs,os,path,serverRoot,runNodeInDatabase,recreateTestDatabase,dropTestDatabase}=require('./suite-context');
const {setup}=require('./26-magento-options.cases');
const templates=require('../src/services/export-templates/template.service');
const bindings=require('../src/services/magento/binding.service');
const labels=require('../src/services/magento/configuration-option-labels');
const option=require('../src/services/magento/configuration-option');
const fixture=require('../test/fixtures/magento-v4');
const c=require('../src/services/magento/binding-contract');
const {getAppConfig}=require('../src/services/catalog/catalog-read-model');
test('migration 057 upgrades nullable historical EN without backfill, rolls back and repeats safely',async()=>{
  const name='amber_en_upgrade_test',url=await recreateTestDatabase(name),db=new Pool({connectionString:url});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-en-checkpoint-'));
  try {
    for(const file of (await fs.readdir(path.join(serverRoot,'migrations'))).filter(f=>f.endsWith('.sql')&&f<'057'))
      await fs.copyFile(path.join(serverRoot,'migrations',file),path.join(directory,file));
    await runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}});`);
    await db.query("INSERT INTO categories(code,name) VALUES('XG','Historical')");
    const q=(await db.query("INSERT INTO questions(category_code,key,label) VALUES('XG','kind','Kind') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,8,'91','Скриньки')",[q]);
    const before=(await db.query('SELECT * FROM options')).rows;
    const sql=await fs.readFile(path.join(serverRoot,'migrations/057_catalog_english_option_labels.sql'),'utf8'),client=await db.connect();
    try {await client.query('BEGIN');await client.query(sql);await client.query('ROLLBACK');}finally{client.release();}
    assert.deepEqual((await db.query('SELECT * FROM options')).rows,before);
    await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations();");
    assert.deepEqual((await db.query('SELECT * FROM options')).rows.map(({label_en,...r})=>{assert.equal(label_en,null);return r;}),before);
    await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations();");
    assert.equal((await db.query("SELECT count(*)::int n FROM schema_migrations WHERE name LIKE '057%' ")).rows[0].n,1);
  }finally{assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});await db.end();await dropTestDatabase(name);}
});
test('catalog authoritative UA/EN commands/read preserve semantic IDs, SKU codes and published history without remote enrollment',async()=>{
  const name='amber_en_catalog_test',f=await setup(name);
  try {
    await f.db.query("UPDATE questions SET include_in_sku=1,sku_index=0 WHERE category_code='XG'");
    await runNodeInDatabase(f.db.options.connectionString,`require('./src/services/sku-schema.service').publishSkuSchema('XG',{mutationContext:{actorUserId:${f.actor}}}).finally(()=>require('./src/db/pool').end());`);
    const history=(await f.db.query('SELECT * FROM sku_schema_options ORDER BY id')).rows;
    await require('./product-fixture').insertProductFixture(f.db,"INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES('XG8001','XG',5,42,'{\"answers\":{\"kind\":8}}') RETURNING id");
    const products=(await f.db.query('SELECT * FROM products ORDER BY id')).rows;
    const requests=(await f.db.query('SELECT * FROM magento_product_sync_requests ORDER BY product_id')).rows;
    const q=(await f.db.query("SELECT id FROM questions WHERE category_code='XG'")).rows[0].id;
    const actor=`{mutationContext:{actorUserId:${f.actor}}}`;
    await runNodeInDatabase(f.db.options.connectionString,`(async()=>{const s=require('./src/services/catalog.service');await s.createOption({question_id:${q},value_id:10,sku_code:'99',label:'Новий',label_en:'New'},${actor});const row=(await require('./src/db/pool').query('SELECT * FROM options WHERE value_id=8')).rows[0];await s.updateOption({...row,label_en:'Amber boxes'},${actor});await require('./src/db/pool').end();})().catch(e=>{console.error(e);process.exitCode=1;});`);
    const config=await getAppConfig(f.db),values=config.questions.XG[0].options;
    assert.equal(values.find(o=>o.id===8).label_en,'Amber boxes');assert.equal(values.find(o=>o.id===10).label_en,'New');
    assert.deepEqual((await f.db.query('SELECT * FROM sku_schema_options ORDER BY id')).rows,history);
    assert.deepEqual((await f.db.query('SELECT value_id,sku_code,label FROM options WHERE value_id=8')).rows,[{value_id:8,sku_code:'8',label:'Скриньки'}]);
    assert.deepEqual((await f.db.query('SELECT * FROM products ORDER BY id')).rows,products);
    assert.deepEqual((await f.db.query('SELECT * FROM magento_product_sync_requests ORDER BY product_id')).rows,requests);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_configuration_actions')).rows[0].n,0);
    await runNodeInDatabase(f.db.options.connectionString,`(async()=>{const p=require('./src/db/pool');const row=(await p.query('SELECT * FROM options WHERE value_id=8')).rows[0];delete row.label_en;await require('./src/services/catalog.service').updateOption(row,${actor});await p.end();})()`);
    assert.equal((await f.db.query('SELECT label_en FROM options WHERE value_id=8')).rows[0].label_en,'Amber boxes');
  }finally{await f.db.end();await dropTestDatabase(name);}
});
async function bound(f) {
  await f.db.query("UPDATE options SET label_en='Amber boxes'");
  const d=fixture.definition();d.sources.color.key='kind';d.tables.colors={'8':'Скриньки'};d.questionContracts.color.allowed=['8'];
  delete d.sources.note;delete d.questionContracts.note;
  for(const g of d.groups){g.columns=g.columns.filter(x=>x!=='new_note').map(x=>x==='kolir'?'fixture_choice':x);for(const r of g.rows){delete r.cells.new_note;if(r.cells.kolir){r.cells.fixture_choice=r.cells.kolir;delete r.cells.kolir;}}}
  const schema=fixture.observation();schema.attributes.push({attribute_id:1471,attribute_code:'fixture_choice',frontend_input:'select',options:[{value:'5738',label:'Скриньки'}]});schema.attributeSets[0].attributeCodes.push('fixture_choice');
  const template=await templates.createTemplate({key:'labels-current',displayName:'Labels current',definition:d},f.options);
  const v=await templates.publishTemplate(template.id,{expectedRevision:template.draft.revision,expectedDefinitionHash:template.draft.definitionHash},f.options);
  let draft=await bindings.createDraft({installationKey:f.draft.installationKey,origin:f.config.baseUrl,templateVersionId:v.id,observedAt:'2026-10-02T00:00:00.000Z',schema},f.options);
  const decisions=fixture.approvedBindings(d,c.normalizeSchema(schema));for(const o of decisions.options){o.optionId='5738';o.skuCodeEvidence='8';}
  draft=await bindings.updateDraft(draft.id,{expectedRevision:draft.revision,bindings:decisions},f.options);
  const published=await bindings.publishDraft(draft.id,{expectedRevision:draft.revision,expectedCurrentId:null},f.options);
  f.input={...f.input,bindingRevisionId:published.id,expectedRevision:published.revision};return published;
}
function adapter(f,{lost=false,absent=false,changedAfterLost=true}={}) {
  let current={all:'Скриньки',en:{storeId:9,label:'Old English'}},revision=c.hash('before'),puts=0;
  const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
  return {get puts(){return puts;},fetch:async(url,init)=>{
    const p=new URL(url).pathname;
    if(init.method==='PUT'){
      assert.equal(p,'/rest/all/V1/amber/attributes/fixture_choice/options/5738/labels');puts++;
      const row=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='option_label' AND state='dispatched'")).rows[0];assert.ok(row);assert.equal(row.remote_id,null);
      const body=JSON.parse(init.body);assert.equal(body.expectedRevision,revision);
      const source=(await f.db.query('SELECT label,label_en FROM options WHERE value_id=8')).rows[0];
      assert.deepEqual(body.labels,{all:source.label,en:{storeId:9,label:source.label_en}});
      if(!lost||changedAfterLost){current=body.labels;revision=c.hash(body);}
      if(lost)throw new Error('Lost PUT response');return json(true);
    }
    assert.equal(init.method,'GET');
    if(p.includes('/V1/amber/'))return absent?json({},404):json({contractVersion:labels.CONTRACT,attributeId:1471,attributeCode:'fixture_choice',optionId:'5738',revision,labels:current});
    if(p.endsWith('/store/storeViews'))return json([{id:9,code:'en',is_active:true}]);
    if(p.endsWith('/fixture_choice/options'))return json([{value:'5738',label:p.startsWith('/rest/en/')?current.en.label:current.all}]);
    if(p.endsWith('/fixture_choice'))return json({attribute_id:1471,attribute_code:'fixture_choice',frontend_input:'select',backend_type:'int',is_user_defined:true,source_model:'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table'});
    throw new Error('Unexpected fixture route');
  }};
}
async function labelReview(f,r) {
  const opt={...f.options,fetchImpl:r.fetch},observed=await labels.inspect(f.config,f.input,opt);
  const a=await labels.attest(f.config,{...f.input,metadataFingerprint:observed.metadataFingerprint,confirmOrdinary:true,confirmHiddenLimit:true,evidence:'Reviewed ordinary attribute and scoped adapter'},opt);
  const command={...f.input,attestationId:a.id},proof=await labels.preview(f.config,command,opt);return {opt,command,proof};
}
test('reviewed approved option EN update requires scoped adapter, durable intent, exact GET and leaves binding unchanged',async()=>{
  const name='amber_option_label_update_test',f=await setup(name),second=new Pool({connectionString:f.db.options.connectionString});
  try {
    const published=await bound(f),missing=adapter(f,{absent:true});
    await assert.rejects(labels.inspect(f.config,f.input,{...f.options,fetchImpl:missing.fetch}),{code:'MAGENTO_OPTION_LABEL_ADAPTER_REQUIRED'});assert.equal(missing.puts,0);
    const r=adapter(f),review=await labelReview(f,r);
    assert.deepEqual(review.proof.differences,[{scope:'en',before:'Old English',after:'Amber boxes'}]);
    await f.db.query("UPDATE options SET label_en='Changed after preview'");
    await assert.rejects(labels.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt));assert.equal(r.puts,0);
    await f.db.query("UPDATE options SET label_en='Amber boxes'");
    const results=await Promise.allSettled([labels.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt),
      labels.apply(f.config,{...review.command,previewToken:review.proof.previewToken},{...review.opt,databasePool:second})]);
    assert.ok(results.some(x=>x.status==='fulfilled'));assert.equal(r.puts,1);
    assert.equal((await f.db.query("SELECT state FROM magento_configuration_actions WHERE kind='option_label'")).rows[0].state,'verified');
    assert.deepEqual(await bindings.getRevision(published.id,f.options),published);
    await assert.rejects(labels.inspect(f.config,{...f.input,attributeCode:'kolir'},review.opt),{code:'MAGENTO_OPTION_APPROVED_BINDING_REQUIRED'});
    const original=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='option_label'")).rows[0];
    await f.db.query("UPDATE options SET label_en='Boxes revised'");assert.equal(r.puts,1);
    const next=await labelReview(f,r);
    assert.equal((await labels.apply(f.config,{...next.command,previewToken:next.proof.previewToken},next.opt)).state,'verified');
    assert.equal(r.puts,2);
    assert.deepEqual((await f.db.query('SELECT * FROM magento_configuration_actions WHERE id=$1',[original.id])).rows[0],original);
    assert.deepEqual(await bindings.getRevision(published.id,f.options),published);
  }finally{await second.end();await f.db.end();await dropTestDatabase(name);}
});
test('lost scoped PUT response remains GET-only reconciliation and never blindly resends across restart',async()=>{
  for(const changedAfterLost of [true,false]){
    const name=`amber_label_lost_${changedAfterLost}_test`,f=await setup(name);
    try {
      await bound(f);const r=adapter(f,{lost:true,changedAfterLost}),review=await labelReview(f,r);
      await assert.rejects(labels.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});
      const row=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='option_label'")).rows[0];assert.equal(row.state,'dispatched');
      if(changedAfterLost)assert.equal((await labels.reconcile(f.config,{actionId:row.id},review.opt)).state,'verified');
      else {await assert.rejects(labels.reconcile(f.config,{actionId:row.id},review.opt));const fresh=await labelReview(f,r);
        const restarted=new Pool({connectionString:f.db.options.connectionString});try{await assert.rejects(labels.apply(f.config,{...fresh.command,previewToken:fresh.proof.previewToken},{...fresh.opt,databasePool:restarted}),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});}finally{await restarted.end();}}
      assert.equal(r.puts,1);
    }finally{await f.db.end();await dropTestDatabase(name);}
  }
});
test('controlled picker reaches products beyond first 100; exact later selection is reviewed and stale changes reject',async()=>{
  const name='amber_controlled_pagination_test',f=await require('./28-magento-publication.cases').setup(name);
  try {
    await require('./product-fixture').insertProductFixture(f.db,`INSERT INTO products(full_sku,category,weight,total_price_uah,details)
      SELECT 'XG-PICKER-'||n,'XG',5,42,'{"answers":{}}' FROM generate_series(1,110) n RETURNING id`);
    const controlled=require('../src/services/magento/binding-controlled-actions');
    const first=await controlled.candidates(f.config,f.current.id,f.options);assert.equal(first.products.length,100);assert.ok(first.nextCursor);
    const second=await controlled.candidates(f.config,f.current.id,f.options,{after:String(first.nextCursor)});
    assert.equal(second.products.length,13);assert.equal(second.nextCursor,null);assert.ok(second.products.every(p=>p.productId>first.nextCursor));
    const ids=[first.products[0].productId,second.products.at(-1).productId],input={bindingRevisionId:f.current.id,expectedRevision:f.current.revision,kind:'broader_resync',productIds:ids,reason:'Reviewed cross-page selection'};
    const proof=await controlled.preview(f.config,input,f.options);assert.deepEqual(proof.products.map(p=>p.productId),ids);
    await f.db.query('UPDATE products SET exclude_from_export=1 WHERE id=$1',[ids[1]]);
    await assert.rejects(controlled.apply(f.config,{...input,previewToken:proof.previewToken},f.options));
    await assert.rejects(controlled.candidates(f.config,f.current.id,f.options,{after:'-1'}));
  }finally{await f.db.end();await dropTestDatabase(name);}
});
