const {test,assert,Pool,fs,os,path,serverRoot,runNodeInDatabase,recreateTestDatabase,dropTestDatabase}=require('./suite-context');
const templates=require('../src/services/export-templates/template.service');
const bindings=require('../src/services/magento/binding.service');
const attribute=require('../src/services/magento/configuration-attribute');
const actions=require('../src/services/magento/configuration-actions');
const fixture=require('../test/fixtures/magento-v4');
const {REQUIRED}=require('../src/services/export-templates/column-contract');

async function setup(name,checkpoint=false){
  const url=await recreateTestDatabase(name);const db=new Pool({connectionString:url});
  try{
    if(checkpoint){
      const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-attribute-upgrade-'));
      try{
        for(const file of (await fs.readdir(path.join(serverRoot,'migrations'))).filter((item)=>item.endsWith('.sql')&&item<'059')){
          await fs.copyFile(path.join(serverRoot,'migrations',file),path.join(directory,file));
        }
        await runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
      }finally{assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});}
    }else await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Attribute admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    const options={databasePool:db,mutationContext:{actorUserId:actor}};
    await db.query("INSERT INTO categories(code,name) VALUES('XG','New category')");
    const definition=fixture.definition();definition.sources={sku:definition.sources.sku};definition.tables={};definition.questionContracts={};
    for(const group of definition.groups){group.columns=[...REQUIRED];for(const row of group.rows){delete row.cells.kolir;delete row.cells.new_note;row.cells.price={op:'literal',value:'42'};}}
    const family=await templates.createTemplate({key:'attribute-test',displayName:'Attribute test',definition},options);
    const publication=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
    const config={configured:true,baseUrl:'https://attribute.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const draft=await bindings.createDraft({installationKey:'attribute-test',origin:config.baseUrl,templateVersionId:publication.id,observedAt:'2026-10-04T00:00:00Z',schema:fixture.observation()},options);
    const input={bindingRevisionId:draft.id,expectedRevision:draft.revision,attributeCode:'amber_new_color',label:'Новий колір',englishLabel:'New color',
      frontendInput:'select',scope:'global',required:false,visibleOnFront:true,searchable:true,filterable:true,filterableInSearch:true};
    return {db,url,actor,options,config,draft,input};
  }catch(cause){await db.end();await dropTestDatabase(name);throw cause;}
}
function fakeMagento(db,{loseCreate=false,loseAssignment=false,failVerification=false}={}){
  let stored=null;let member=false;let posts=0;let pair=[];let pairs=false;
  return {get posts(){return posts;},get stored(){return stored;},get member(){return member;},
    pairReads(){pairs=true;}, change(patch){stored={...stored,...patch};},
    fetch:async(url,init)=>{
      const parsed=new URL(url);const p=parsed.pathname;let data;
      if(init.method==='POST'){
        const kind=p.endsWith('/attribute-sets/attributes')?'attribute_assignment':'attribute';
        const rows=(await db.query("SELECT * FROM magento_configuration_actions WHERE kind=$1 AND state='dispatched'",[kind])).rows;
        assert.equal(rows.length,1);assert.equal(rows[0].remote_id,null);posts++;
        const body=JSON.parse(init.body);
        if(kind==='attribute'){
          assert.equal(Object.hasOwn(body.attribute,'attribute_id'),false);
          stored={...body.attribute,attribute_id:9901,backend_type:body.attribute.frontend_input==='text'?'varchar':'int',backend_model:null,
            source_model:body.attribute.frontend_input==='text'?null:'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table',options:[]};
          if(loseCreate)throw new Error('Lost attribute create response');data=stored;
        }else{assert.equal(body.attributeCode,stored.attribute_code);member=true;if(loseAssignment)throw new Error('Lost assignment response');data=4401;}
      }else{
        assert.equal(init.method,'GET');
        if(p.endsWith('/store/storeViews'))data=[{id:3,code:'en',is_active:true}];
        else if(p.endsWith('/products/attributes')){
          data={items:stored?[stored]:[],total_count:stored?1:0};
          if(pairs){await new Promise((resolve)=>{pair.push(resolve);if(pair.length===2){const current=pair;pair=[];current.forEach((done)=>done());}});}
        }else if(p.endsWith('/products/attributes/amber_new_color')){
          if(failVerification){failVerification=false;throw new Error('GET temporarily unavailable');}data=stored;
        }else if(p.endsWith('/attribute-sets/8001'))data={attribute_set_id:8001,attribute_set_name:'Fixture set'};
        else if(p.endsWith('/attribute-sets/groups/list'))data={items:[{attribute_group_id:81,attribute_set_id:8001,attribute_group_name:'Основні'}],total_count:1};
        else if(p.endsWith('/attribute-sets/8001/attributes'))data=member?[stored]:[];
        else throw new Error(`Unexpected fixture GET ${p}`);
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    }};
}
async function create(f,remote){
  const options={...f.options,fetchImpl:remote.fetch};const proof=await attribute.preview(f.config,f.input,options);
  return attribute.apply(f.config,{...f.input,previewToken:proof.previewToken},options);
}
const assignment=(f)=>({bindingRevisionId:f.draft.id,expectedRevision:f.draft.revision,attributeCode:f.input.attributeCode,attributeSetId:8001,attributeGroupId:81,sortOrder:9});

test('attribute CREATE races use independent connections and one committed immutable intent before one POST',async()=>{
  const name='amber_attribute_race_test';const f=await setup(name);const second=new Pool({connectionString:f.url});
  try{
    const remote=fakeMagento(f.db);const proof=await attribute.preview(f.config,f.input,{...f.options,fetchImpl:remote.fetch});remote.pairReads();
    const results=await Promise.allSettled([f.db,second].map((databasePool)=>attribute.apply(f.config,{...f.input,previewToken:proof.previewToken},{...f.options,databasePool,fetchImpl:remote.fetch})));
    assert.equal(results.filter((result)=>result.status==='fulfilled').length,1);assert.equal(remote.posts,1);
    const rows=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='attribute'")).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].state,'verified');assert.equal(rows[0].remote_id,'9901');
    assert.equal(rows[0].intent.body.attribute.is_required,false);
    await assert.rejects(f.db.query("UPDATE magento_configuration_actions SET intent='{}'::jsonb WHERE id=$1",[rows[0].id]));
    await assert.rejects(f.db.query('DELETE FROM magento_configuration_actions WHERE id=$1',[rows[0].id]));
    const unchanged=await bindings.getRevision(f.draft.id,f.options);assert.equal(unchanged.revision,f.draft.revision);assert.equal(unchanged.state,'draft');
  }finally{await second.end();await f.db.end();await dropTestDatabase(name);}
});
test('attribute returned identity recovers only with exact GET; lost create response remains uncertain and never resends',async()=>{
  for(const lost of [false,true]){
    const name=`amber_attribute_recovery_${lost?'lost':'returned'}_test`;const f=await setup(name);
    try{
      const remote=fakeMagento(f.db,{loseCreate:lost,failVerification:!lost});const options={...f.options,fetchImpl:remote.fetch};
      await assert.rejects(create(f,remote),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});
      const row=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='attribute'")).rows[0];
      assert.equal(row.state,lost?'dispatched':'returned');
      if(lost)await assert.rejects(attribute.reconcile(f.config,{actionId:row.id},options),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});
      else assert.equal((await attribute.reconcile(f.config,{actionId:row.id},options)).state,'verified');
      await assert.rejects(create(f,remote),{code:'MAGENTO_ATTRIBUTE_ALREADY_EXISTS'});assert.equal(remote.posts,1);
    }finally{await f.db.end();await dropTestDatabase(name);}
  }
});
test('new attribute assignment is separate reviewed exact membership; lost assignment response is GET-only recovery',async()=>{
  const name='amber_attribute_assignment_test';const f=await setup(name);
  try{
    const remote=fakeMagento(f.db,{loseAssignment:true});const options={...f.options,fetchImpl:remote.fetch};
    const created=await create(f,remote);assert.equal(created.state,'verified');assert.equal(remote.member,false);
    const input=assignment(f);const proof=await attribute.assignmentPreview(f.config,input,options);
    await assert.rejects(attribute.assignmentApply(f.config,{...input,previewToken:proof.previewToken},options),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});
    const row=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='attribute_assignment'")).rows[0];
    assert.equal(row.state,'dispatched');
    const result=await attribute.reconcile(f.config,{actionId:row.id},options);
    assert.equal(result.state,'verified');assert.equal(result.attributeSet.id,8001);assert.equal(result.assignmentPlacementVerified,false);
    assert.equal((await actions.get(f.config,row.id,f.options)).verification.membershipVerified,true);
    await assert.rejects(attribute.assignmentPreview(f.config,input,options),{code:'MAGENTO_ATTRIBUTE_ALREADY_ASSIGNED'});assert.equal(remote.posts,2);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('attribute preview and final dispatch retain Administrator and source revision checks without remote writes',async()=>{
  const name='amber_attribute_authority_test';const f=await setup(name);
  try{
    const remote=fakeMagento(f.db);const options={...f.options,fetchImpl:remote.fetch};
    await assert.rejects(attribute.preview(f.config,{...f.input,expectedRevision:'99'},options),{code:'MAGENTO_BINDING_CONFLICT'});
    const proof=await attribute.preview(f.config,f.input,options);
    const other=Number((await f.db.query("INSERT INTO application_users(status,display_name) VALUES('active','Delegated publisher') RETURNING id")).rows[0].id);
    const role=(await f.db.query("INSERT INTO roles(role_key,display_name,description,is_system,status) VALUES('attribute_publisher','Publisher','Test only',false,'active') RETURNING id")).rows[0].id;
    await f.db.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'export_templates.manage'),($1,'export_templates.publish')",[role]);
    await f.db.query('INSERT INTO user_role_assignments(application_user_id,role_id) VALUES($1,$2)',[other,role]);
    await assert.rejects(attribute.preview(f.config,f.input,{...options,mutationContext:{actorUserId:other}}),{code:'MAGENTO_ATTRIBUTE_ADMINISTRATOR_REQUIRED'});
    const sealed=await actions.seal(f.config,proof,options);
    await assert.rejects(actions.transition(sealed.id,'sealed','dispatched',{}, {...options,mutationContext:{actorUserId:other}}),{code:'MAGENTO_ATTRIBUTE_ADMINISTRATOR_REQUIRED'});
    assert.equal((await actions.get(f.config,sealed.id,f.options)).state,'sealed');assert.equal(remote.posts,0);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('attribute migration upgrades 058 transactionally, preserves prior actions and repeats startup',async()=>{
  const name='amber_attribute_upgrade_test';const f=await setup(name,true);
  try{
    const contract=require('../src/services/magento/binding-contract');
    const oldIntent={path:'Default/Historical fixture'};
    await f.db.query(`INSERT INTO magento_configuration_actions
      (id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent)
      VALUES('00000000-0000-0000-0000-000000000058','category',$1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [contract.originHash(f.config.baseUrl),contract.hash(oldIntent),f.draft.id,f.draft.revision,f.actor,contract.hash(oldIntent),JSON.stringify(oldIntent)]);
    const original=(await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='category'")).rows;
    const sql=await fs.readFile(path.join(serverRoot,'migrations/059_magento_attribute_actions.sql'),'utf8');const conn=await f.db.connect();
    try{
      await conn.query('BEGIN');await conn.query(sql);await conn.query('ROLLBACK');
      const definition=(await conn.query("SELECT pg_get_constraintdef(oid) AS value FROM pg_constraint WHERE conname='magento_configuration_actions_kind_check'")).rows[0].value;
      assert.equal(definition.includes('attribute_assignment'),false);
    }finally{conn.release();}
    for(let n=0;n<2;n++)await runNodeInDatabase(f.url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    assert.deepEqual((await f.db.query("SELECT * FROM magento_configuration_actions WHERE kind='category'")).rows,original);
    const remote=fakeMagento(f.db);assert.equal((await create(f,remote)).state,'verified');
    assert.equal(Number((await f.db.query("SELECT count(*) FROM schema_migrations WHERE name='059_magento_attribute_actions.sql'")).rows[0].count),1);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
