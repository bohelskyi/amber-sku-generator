const { test,assert,Pool,runNodeInDatabase,recreateTestDatabase,dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const option = require('../src/services/magento/configuration-option');
const actions = require('../src/services/magento/configuration-actions');
const fixture = require('../test/fixtures/magento-v4');
const { REQUIRED } = require('../src/services/export-templates/column-contract');
async function setup(name) {
  const url = await recreateTestDatabase(name); const db = new Pool({connectionString:url});
  await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Option admin') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
  const options = { databasePool:db,mutationContext:{actorUserId:actor} };
  await db.query("INSERT INTO categories(code,name) VALUES('XG','New category')");
  const q = (await db.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku) VALUES('XG','kind','Kind','options',0) RETURNING id")).rows[0].id;
  await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,8,'8','Скриньки')",[q]);
  const d = fixture.definition(); d.sources={sku:d.sources.sku};d.tables={};d.questionContracts={};
  for(const g of d.groups){g.columns=[...REQUIRED];for(const r of g.rows){delete r.cells.kolir;delete r.cells.new_note;r.cells.price={op:'literal',value:'42'};}}
  const f=await templates.createTemplate({key:'option-test',displayName:'Option test',definition:d},options);
  const v=await templates.publishTemplate(f.id,{expectedRevision:f.draft.revision,expectedDefinitionHash:f.draft.definitionHash},options);
  const config={configured:true,baseUrl:'https://option.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
  const draft=await bindings.createDraft({installationKey:'option-test',origin:config.baseUrl,templateVersionId:v.id,observedAt:'2026-10-02T00:00:00.000Z',schema:fixture.observation()},options);
  const input={bindingRevisionId:draft.id,expectedRevision:draft.revision,attributeCode:'fixture_choice',amberGroup:'XG',questionKey:'kind',valueId:'8'};
  return {db,options,actor,config,draft,input};
}
function remote(db,{lost=false,failVerification=false,firstOption=false,addedDefaultValue=''}={}) {
  const attribute={attribute_id:1471,attribute_code:'fixture_choice',frontend_input:'select',backend_type:'int',is_user_defined:true,source_model:'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table'};
  let created=false,posts=0;
  return {attribute,hideCreated:()=>{created=false;},get posts(){return posts;},fetch:async(url,init)=>{
    const path=new URL(url).pathname;let data;
    if(init.method==='POST'){
      assert.equal(path,'/rest/all/V1/products/attributes/fixture_choice/options');
      const rows=(await db.query("SELECT * FROM magento_configuration_actions WHERE kind='option' AND state='dispatched'")).rows;
      assert.equal(rows.length,1);assert.ok(rows[0].attestation_id);assert.equal(rows[0].remote_id,null);
      const body=JSON.parse(init.body);assert.equal(body.option.label,'Скриньки');assert.equal(body.option.is_default,false);
      posts++;created=true;if(lost)throw new Error('lost response');data='5738';
    }else{
      assert.equal(init.method,'GET');
      if(path.endsWith('/store/storeViews'))data=[];
      else if(path.endsWith('/fixture_choice'))data=firstOption&&created?{...attribute,default_value:addedDefaultValue}:attribute;
      else if(path.endsWith('/fixture_choice/options')){
        if(created&&failVerification){failVerification=false;throw new Error('GET unavailable');}
        data=[...(firstOption?[{value:'',label:' '}]:[{value:'10',label:'Існуюче'}]),...(created?[{value:'5738',label:'Скриньки'}]:[])];
      }else throw new Error('Unexpected fixture GET');
    }
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  }};
}
async function reviewed(f,r) {
  const opt={...f.options,fetchImpl:r.fetch};const observed=await option.inspect(f.config,f.input,opt);
  const a=await option.attest(f.config,{...f.input,metadataFingerprint:observed.metadataFingerprint,confirmOrdinary:true,confirmHiddenLimit:true,evidence:'Administrator reviewed the ordinary type for this action'},opt);
  const command={...f.input,attestationId:a.id};const proof=await option.preview(f.config,command,opt);
  return {opt,command,proof,a};
}

test('H4 active EN store requires the authoritative Amber English catalog label, never caller text',async()=>{
  const name='amber_option_en_required_test',f=await setup(name);
  try {
    const r=remote(f.db);
    const opt={...f.options,fetchImpl:async(url,init)=>new URL(url).pathname.endsWith('/store/storeViews')
      ? new Response(JSON.stringify([{id:9,code:'en',is_active:true}]),{headers:{'Content-Type':'application/json'}})
      : r.fetch(url,init)};
    await assert.rejects(option.inspect(f.config,f.input,opt),{code:'MAGENTO_OPTION_EN_LABEL_REQUIRED'});
    await assert.rejects(option.inspect(f.config,{...f.input,englishLabel:'Invented',englishAuthoritative:true},opt));
    assert.equal(r.posts,0);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('sealed option crash recovery: expired immutable attestation is replaced by fresh Administrator review with one concurrent POST',async()=>{
  const name='amber_option_reseal_test',f=await setup(name),second=new Pool({connectionString:f.db.options.connectionString});
  try{
    const r=remote(f.db),first=await reviewed(f,r);
    const expiring=(await f.db.query(`INSERT INTO magento_option_capability_attestations
      (id,origin_hash,installation_key,attribute_id,attribute_code,metadata_fingerprint,target_hash,target,actor_user_id,evidence,created_at,expires_at)
      SELECT '00000000-0000-0000-0000-000000000003',origin_hash,installation_key,attribute_id,attribute_code,metadata_fingerprint,target_hash,target,actor_user_id,evidence,
        statement_timestamp()-INTERVAL '9 minutes 55 seconds',statement_timestamp()+INTERVAL '5 seconds'
      FROM magento_option_capability_attestations WHERE id=$1 RETURNING id`,[first.a.id])).rows[0];
    // Use one statement timestamp for the exact ten-minute database invariant.
    const command={...first.command,attestationId:expiring.id},proof=await option.preview(f.config,command,first.opt);
    await runNodeInDatabase(f.db.options.connectionString,`require('./src/services/magento/configuration-actions').seal(${JSON.stringify(f.config)},${JSON.stringify(proof)},{mutationContext:{actorUserId:${f.actor}}}).then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});`);
    await f.db.query('SELECT pg_sleep(5)');
    await assert.rejects(option.preview(f.config,command,first.opt),{code:'MAGENTO_OPTION_ATTESTATION_STALE'});
    const prior=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];
    const fresh=await reviewed(f,r);
    const results=await Promise.allSettled([option.apply(f.config,{...fresh.command,previewToken:fresh.proof.previewToken},fresh.opt),
      option.apply(f.config,{...fresh.command,previewToken:fresh.proof.previewToken},{...fresh.opt,databasePool:second})]);
    assert.ok(results.some(x=>x.status==='fulfilled'));assert.equal(r.posts,1);
    const rows=(await f.db.query('SELECT * FROM magento_configuration_actions ORDER BY created_at')).rows;
    assert.equal(rows.length,2);assert.equal(rows[0].state,'superseded');assert.deepEqual(rows[0].intent,prior.intent);
    assert.equal(rows[1].attestation_id,fresh.a.id);assert.equal(rows[1].supersedes_id,prior.id);assert.equal(rows[1].state,'verified');
    await assert.rejects(actions.transition(prior.id,'sealed','dispatched',{},fresh.opt));assert.equal(r.posts,1);
  }finally{await second.end();await f.db.end();await dropTestDatabase(name);}
});
test('H4 Administrator attestation: absent, expired, changed metadata and unsupported types fail closed',async()=>{
  const name='amber_option_attestation_test',f=await setup(name);
  try{
    const r=remote(f.db),{opt,command,a}=await reviewed(f,r);
    await f.db.query("UPDATE application_users SET status='disabled' WHERE id=$1",[f.actor]);
    await assert.rejects(option.preview(f.config,command,opt),{code:'MAGENTO_OPTION_ADMINISTRATOR_REQUIRED'});
    await f.db.query("UPDATE application_users SET status='active' WHERE id=$1",[f.actor]);
    await assert.rejects(option.preview(f.config,{...f.input,attestationId:'00000000-0000-0000-0000-000000000001'},opt),{code:'MAGENTO_OPTION_ATTESTATION_STALE'});
    const expired=(await f.db.query(`INSERT INTO magento_option_capability_attestations
      (id,origin_hash,installation_key,attribute_id,attribute_code,metadata_fingerprint,target_hash,target,actor_user_id,evidence,created_at,expires_at)
      SELECT '00000000-0000-0000-0000-000000000002',origin_hash,installation_key,attribute_id,attribute_code,metadata_fingerprint,target_hash,target,actor_user_id,evidence,
        CURRENT_TIMESTAMP-INTERVAL '20 minutes',CURRENT_TIMESTAMP-INTERVAL '10 minutes' FROM magento_option_capability_attestations WHERE id=$1 RETURNING id`,[a.id])).rows[0];
    await assert.rejects(option.preview(f.config,{...command,attestationId:expired.id},opt),{code:'MAGENTO_OPTION_ATTESTATION_STALE'});
    r.attribute.attribute_id=1500;await assert.rejects(option.preview(f.config,command,opt),{code:'MAGENTO_OPTION_ATTESTATION_STALE'});
    r.attribute.attribute_id=1471;r.attribute.additional_data='{"swatch_input_type":"visual"}';
    await assert.rejects(option.inspect(f.config,f.input,opt),{code:'MAGENTO_OPTION_CAPABILITY_UNSUPPORTED'});
    assert.equal(r.posts,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_configuration_actions')).rows[0].n,0);
    await assert.rejects(f.db.query('UPDATE magento_option_capability_attestations SET evidence=$2 WHERE id=$1',[a.id,'changed']),/immutable/);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('H4 real concurrent option apply commits intent/attestation before one POST and never approves binding',async()=>{
  const name='amber_option_race_test',f=await setup(name);const second=new Pool({connectionString:f.db.options.connectionString});
  try{
    const r=remote(f.db),{opt,command,proof}=await reviewed(f,r);let arrivals=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    const fetch=async(url,init)=>{if(new URL(url).pathname.endsWith('/fixture_choice')&&arrivals<2){if(++arrivals===2)release();await barrier;}return r.fetch(url,init);};
    const result=await Promise.allSettled([option.apply(f.config,{...command,previewToken:proof.previewToken},{...opt,fetchImpl:fetch}),
      option.apply(f.config,{...command,previewToken:proof.previewToken},{...opt,fetchImpl:fetch,databasePool:second})]);
    assert.equal(arrivals,2);assert.ok(result.some(x=>x.status==='fulfilled'));assert.equal(r.posts,1);
    const rows=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows;assert.equal(rows.length,1);assert.equal(rows[0].state,'verified');assert.equal(rows[0].remote_id,'5738');
    assert.deepEqual(await bindings.getRevision(f.draft.id,f.options),f.draft);
  }finally{await second.end();await f.db.end();await dropTestDatabase(name);}
});
test('H4 exact returned identity supports GET-only recovery; lost response cannot be inferred or resent',async()=>{
  for(const lost of [false,true]){
    const name=`amber_option_recovery_${lost?'lost':'returned'}_test`,f=await setup(name);
    try{
      const r=remote(f.db,{lost,failVerification:!lost}),{opt,command,proof}=await reviewed(f,r);
      await assert.rejects(option.apply(f.config,{...command,previewToken:proof.previewToken},opt));
      const row=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];
      if(lost){assert.equal(row.state,'dispatched');assert.equal(row.remote_id,null);await assert.rejects(option.reconcile(f.config,{actionId:row.id},opt),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});
        r.hideCreated();const restarted=new Pool({connectionString:f.db.options.connectionString});
        try{const fresh=await reviewed(f,r);await assert.rejects(option.apply(f.config,{...fresh.command,previewToken:fresh.proof.previewToken},{...fresh.opt,databasePool:restarted}),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});}
        finally{await restarted.end();}
      }
      else{assert.equal(row.state,'returned');assert.equal((await option.reconcile(f.config,{actionId:row.id},opt)).state,'verified');}
      assert.equal(r.posts,1);
    }finally{await f.db.end();await dropTestDatabase(name);}
  }
});
test('H4 PostgreSQL EN label is authoritative, scoped and GET verified; SKU values need publication',async()=>{
  const name='amber_option_labels_test',f=await setup(name);
  try {
    const r=remote(f.db),input=f.input;
    await f.db.query("UPDATE options SET label_en='Amber boxes'");
    const fetch=async(url,init)=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/store/storeViews'))return new Response(JSON.stringify([{id:9,code:'en',is_active:true}]),{headers:{'Content-Type':'application/json'}});
      if(path.startsWith('/rest/en/'))return new Response(JSON.stringify([{value:'10',label:'Existing'},...(r.posts?[{value:'5738',label:'Amber boxes'}]:[])]),{headers:{'Content-Type':'application/json'}});
      if(init.method==='POST')assert.deepEqual(JSON.parse(init.body).option.store_labels,[{store_id:0,label:'Скриньки'},{store_id:9,label:'Amber boxes'}]);
      return r.fetch(url,init);
    };
    const opt={...f.options,fetchImpl:fetch};
    await assert.rejects(option.inspect(f.config,{...input,englishLabel:'Caller text',englishAuthoritative:true},opt),{code:'MAGENTO_BINDING_INVALID'});
    await f.db.query("UPDATE questions SET include_in_sku=1,sku_index=0 WHERE category_code='XG'");
    await assert.rejects(option.inspect(f.config,input,opt),{code:'MAGENTO_OPTION_AMBER_SCHEMA_REQUIRED'});
    await f.db.query("UPDATE questions SET include_in_sku=0 WHERE category_code='XG'");
    const observed=await option.inspect(f.config,input,opt);
    const a=await option.attest(f.config,{...input,metadataFingerprint:observed.metadataFingerprint,confirmOrdinary:true,confirmHiddenLimit:true,evidence:'Reviewed ordinary attribute and explicit authoritative EN label'},opt);
    const command={...input,attestationId:a.id},proof=await option.preview(f.config,command,opt);
    const result=await option.apply(f.config,{...command,previewToken:proof.previewToken},opt);
    assert.equal(result.state,'verified');assert.equal(result.remoteId,'5738');
    const attested=(await f.db.query('SELECT target FROM magento_option_capability_attestations WHERE id=$1',[a.id])).rows[0].target;
    assert.equal(attested.englishLabel,'Amber boxes');assert.equal(attested.valueId,'8');
  } finally {await f.db.end();await dropTestDatabase(name);}
});

module.exports={setup,remote,reviewed};

test('H4 first non-default option proves the immutable metadata preimage with exact UA/EN ID and GET-only recovery',async()=>{
  for(const failVerification of [false,true]){
    const name='amber_option_race_test',f=await setup(name);
    try {
      await f.db.query("UPDATE options SET label_en='Amber boxes'");
      const r=remote(f.db,{firstOption:true,failVerification});
      const fetch=async(url,init)=>{
        const p=new URL(url).pathname;
        if(p.endsWith('/store/storeViews'))return new Response(JSON.stringify([{id:9,code:'en',is_active:true}]),{headers:{'Content-Type':'application/json'}});
        if(p.startsWith('/rest/en/'))return new Response(JSON.stringify([{value:'',label:' '},...(r.posts?[{value:'5738',label:'Amber boxes'}]:[])]),{headers:{'Content-Type':'application/json'}});
        if(init.method==='POST')assert.deepEqual(JSON.parse(init.body).option.store_labels,[{store_id:0,label:'Скриньки'},{store_id:9,label:'Amber boxes'}]);
        return r.fetch(url,init);
      };
      const review=await reviewed(f,{fetch});
      if(failVerification)await assert.rejects(option.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt));
      else assert.equal((await option.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt)).state,'verified');
      const before=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];
      assert.equal(before.remote_id,'5738');assert.equal(before.state,failVerification?'returned':'verified');
      assert.equal((await option.reconcile(f.config,{actionId:before.id},review.opt)).state,'verified');
      const after=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];
      assert.deepEqual(after.intent,before.intent);assert.equal(after.intent.metadataFingerprint,review.proof.metadataFingerprint);
      assert.equal(after.verification.metadataPreimage.mode,'first_non_default_option_empty_default_added');
      assert.equal(after.verification.metadataPreimage.sealedFingerprint,review.proof.metadataFingerprint);
      assert.equal(after.verification.englishStoreId,9);assert.equal(after.verification.englishLabel,'Amber boxes');
      const attestation=(await f.db.query('SELECT metadata_fingerprint FROM magento_option_capability_attestations WHERE id=$1',[review.a.id])).rows[0];
      assert.equal(attestation.metadata_fingerprint,review.proof.metadataFingerprint);
      assert.equal(r.posts,1);assert.deepEqual(await bindings.getRevision(f.draft.id,f.options),f.draft);
    }finally{await f.db.end();await dropTestDatabase(name);}
  }
});

test('H4 a real default added during first option creation remains returned and cannot be verified or resent',async()=>{
  const name='amber_option_recovery_returned_test',f=await setup(name);
  try {
    const r=remote(f.db,{firstOption:true,addedDefaultValue:'5738'}),review=await reviewed(f,r);
    await assert.rejects(option.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt),{code:'MAGENTO_OPTION_METADATA_DRIFT'});
    const row=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];
    assert.equal(row.state,'returned');assert.equal(row.remote_id,'5738');
    await assert.rejects(option.reconcile(f.config,{actionId:row.id},review.opt),{code:'MAGENTO_OPTION_METADATA_DRIFT'});
    assert.equal(r.posts,1);assert.deepEqual(await bindings.getRevision(f.draft.id,f.options),f.draft);
  }finally{await f.db.end();await dropTestDatabase(name);}
});

test('H4 ambiguous authoritative source labels block review and sealed dispatch without a POST',async()=>{
  const name='amber_option_ambiguous_labels_test',f=await setup(name);
  try {
    const r=remote(f.db),review=await reviewed(f,r);
    const original=(await f.db.query('SELECT * FROM options')).rows[0];
    const duplicate=(await f.db.query(`INSERT INTO options(question_id,value_id,sku_code,label,label_en)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[original.question_id,original.value_id,original.sku_code,original.label,original.label_en])).rows[0];
    await option.inspect(f.config,f.input,review.opt);
    for(const labels of [['Інша назва',null],[original.label,'Different English']]){
      await f.db.query('UPDATE options SET label=$2,label_en=$3 WHERE id=$1',[duplicate.id,...labels]);
      await assert.rejects(option.inspect(f.config,f.input,review.opt),{code:'MAGENTO_OPTION_AMBER_SOURCE_AMBIGUOUS'});
      await assert.rejects(actions.seal(f.config,review.proof,review.opt),{code:'MAGENTO_OPTION_AMBER_SOURCE_AMBIGUOUS'});
    }
    assert.equal(r.posts,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_configuration_actions')).rows[0].n,0);
  }finally{await f.db.end();await dropTestDatabase(name);}
});

test('H4 CREATE binds absent and exact active EN scope through review, dispatch and GET reconciliation',async()=>{
  const name='amber_option_scope_review_test',f=await setup(name);
  try {
    await f.db.query("UPDATE options SET label_en='Amber boxes'");
    const r=remote(f.db);let storeId=null,changeAfterPost=false;
    const wrapped={fetch:async(url,init)=>{
      const path=new URL(url).pathname;
      if(path.endsWith('/store/storeViews'))return new Response(JSON.stringify(storeId?[{id:storeId,code:'en',is_active:1}]:[]),{headers:{'Content-Type':'application/json'}});
      if(path.startsWith('/rest/en/'))return new Response(JSON.stringify([{value:'10',label:'Existing'},...(r.posts?[{value:'5738',label:'Amber boxes'}]:[])]),{headers:{'Content-Type':'application/json'}});
      const result=await r.fetch(url,init);if(init.method==='POST'&&changeAfterPost)storeId=9;return result;
    }};
    const noEn=await reviewed(f,wrapped);assert.equal(noEn.proof.englishStoreId,null);
    storeId=9;
    await assert.rejects(option.apply(f.config,{...noEn.command,previewToken:noEn.proof.previewToken},noEn.opt),{code:'MAGENTO_CONFIGURATION_PREVIEW_STALE'});
    const withEn=await reviewed(f,wrapped);assert.equal(withEn.proof.englishStoreId,9);
    for(const next of [null,10]){
      storeId=next;
      await assert.rejects(option.apply(f.config,{...withEn.command,previewToken:withEn.proof.previewToken},withEn.opt),{code:'MAGENTO_CONFIGURATION_PREVIEW_STALE'});
    }
    assert.equal(r.posts,0);
    storeId=null;changeAfterPost=true;
    await assert.rejects(option.apply(f.config,{...noEn.command,previewToken:noEn.proof.previewToken},noEn.opt),{code:'MAGENTO_OPTION_EN_SCOPE_UNRESOLVED'});
    const action=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];assert.equal(action.state,'returned');assert.equal(r.posts,1);
    storeId=null;
    assert.equal((await option.reconcile(f.config,{actionId:action.id},noEn.opt)).state,'verified');assert.equal(r.posts,1);
  }finally{await f.db.end();await dropTestDatabase(name);}
});

test('H4 exact CREATE verification rejects UA fallback in EN and preserves returned identity for GET-only recovery',async()=>{
  const name='amber_option_en_verify_test',f=await setup(name);
  try {
    await f.db.query("UPDATE options SET label_en='Amber boxes'");
    const r=remote(f.db);let wrong=true;
    const fetch=async(url,init)=>{
      const p=new URL(url).pathname;
      if(p.endsWith('/store/storeViews'))return new Response(JSON.stringify([{id:9,code:'en',is_active:true}]),{headers:{'Content-Type':'application/json'}});
      if(p.startsWith('/rest/en/'))return new Response(JSON.stringify([{value:'10',label:'Existing'},...(r.posts?[{value:'5738',label:wrong?'Скриньки':'Amber boxes'}]:[])]),{headers:{'Content-Type':'application/json'}});
      return r.fetch(url,init);
    };
    const review=await reviewed(f,{fetch});
    await assert.rejects(option.apply(f.config,{...review.command,previewToken:review.proof.previewToken},review.opt),{code:'MAGENTO_OPTION_VERIFICATION_FAILED'});
    const row=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];assert.equal(row.state,'returned');assert.equal(row.remote_id,'5738');
    wrong=false;assert.equal((await option.reconcile(f.config,{actionId:row.id},review.opt)).state,'verified');assert.equal(r.posts,1);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
