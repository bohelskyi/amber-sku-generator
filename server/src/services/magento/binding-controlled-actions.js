const pool=require('../../db/pool');
const c=require('./binding-contract');
const editor=require('./integration-editor.service');
const publication=require('./binding-publication');
const repository=require('./binding-repository');
const handoff=require('./binding-handoff');
const {readPreviewProductOnClient}=require('./sync-preview-db');
const {evaluate}=require('./binding-evidence-products');
const {same}=require('./name-reconciliation');
const {nameStateEvidence,auditName}=require('./name-state');
const {createMutationContext}=require('../../audit/mutation-context');
const {runAccessAdminMutation,assertActorStillAuthorized}=require('../access-admin-transaction');
const {writeAuditEvent}=require('../../audit/audit-events');
const {readFullProductStates,advanceFullProductRevision}=require('../full-product-export.service');
function command(input,apply=false){
  c.command(input,['bindingRevisionId','expectedRevision','kind','productIds','reason'],apply?['previewToken']:[]);
  c.identity(input.bindingRevisionId);c.counter(input.expectedRevision);
  if(!['broader_resync','name_rule'].includes(input.kind)||!Array.isArray(input.productIds)||input.productIds.length<1||input.productIds.length>100
    ||new Set(input.productIds).size!==input.productIds.length||input.productIds.some((id)=>!Number.isSafeInteger(id)||id<=0)
    ||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>2000)c.invalid();
}
async function inspect(client,config,input){
  const revision=await editor.selected(client,config,input.bindingRevisionId),current=await repository.current(client,revision.installationKey);
  if(revision.state!=='published'||revision.revision!==c.counter(input.expectedRevision)||current?.id!==revision.id)
    throw c.error(409,'MAGENTO_BINDING_CONFLICT','Current publication changed');
  const products=[],blockers=[];
  for(const id of [...input.productIds].sort((a,b)=>a-b)){
    const amber=await readPreviewProductOnClient(client,{productId:id,bindingRevisionId:revision.id});
    const product=amber.product;
    if(product.status!=='active'||product.corrected_to_product_id!==null||Number(product.exclude_from_export)!==0
      ||(await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rowCount){blockers.push({productId:id,code:'PRODUCT_NOT_CURRENT_OR_EXCLUDED'});continue;}
    const request=(await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rows[0] || null;
    const protectedWork=request?.reason_code==='reconciliation_required'||(await client.query(`SELECT 1 FROM magento_sync_jobs j
      WHERE j.public_product_identity_id=$1 AND j.origin_hash=$2 AND j.state NOT IN ('succeeded','superseded')
        AND (j.automatic_generation IS NULL OR j.state='uncertain' OR EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id)) LIMIT 1`,[product.public_product_identity_id,revision.originHash])).rowCount>0;
    if(protectedWork)blockers.push({productId:id,code:'RECONCILIATION_REQUIRED'});
    if(input.kind==='name_rule' && ['conflict','baseline_required'].includes(amber.nameState?.state))blockers.push({productId:id,code:'NAME_CONFLICT_OR_BASELINE_REQUIRED'});
    const mapped=evaluate(amber,product),raw=Object.assign(Object.create(Object.getPrototypeOf(product)),product);
    // Keep the supported product's historical source association: temporarily
    // omit only the two exact-name representations when evaluating the rule.
    const override=product.magento_name_override,pin=product.magento_name_rule_pin;
    delete product.magento_name_override;delete product.magento_name_rule_pin;
    const generated=evaluate(amber,product);
    Object.assign(product,raw);
    if(override!==undefined)product.magento_name_override=override;if(pin!==undefined)product.magento_name_rule_pin=pin;
    const before={all:mapped.base.name ?? null,en:mapped.english.name ?? null},after={all:generated.base.name ?? null,en:generated.english.name ?? null};
    if(input.kind==='name_rule')try{require('./product-names.service').validateNames(after);}catch{blockers.push({productId:id,code:'INVALID_GENERATED_NAMES'});}
    products.push({productId:id,publicIdentityId:product.public_product_identity_id,article:product.public_sku,
      before,after,changed:!same(before,after),generated:generated.generatedNames,
      evidenceHash:c.hash(JSON.parse(JSON.stringify({product,request,nameState:nameStateEvidence(amber.nameState)})))});
  }
  return {revision,products,blockers};
}
async function preview(config,input,options={}){
  command(input);const report=await editor.read(options,(client)=>inspect(client,config,input));
  return {...report,previewToken:c.hash({input,report})};
}
async function candidates(config,id,options={}){
  c.identity(id);
  return editor.read(options,async(client)=>{
    const revision=await editor.selected(client,config,id),current=await repository.current(client,revision.installationKey);
    if(revision.state!=='published'||current?.id!==id)throw c.error(409,'MAGENTO_BINDING_CONFLICT','Current publication changed');
    const rows=(await client.query(`SELECT id,count(*) OVER()::int AS total FROM products p WHERE status='active' AND corrected_to_product_id IS NULL
      AND exclude_from_export=0 AND NOT EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=p.public_product_identity_id)
      ORDER BY id LIMIT 100`)).rows;
    if(!rows.length)return {products:[],unexamined:0};
    const report=await inspect(client,config,{bindingRevisionId:id,expectedRevision:revision.revision,kind:'name_rule',productIds:rows.map((r)=>r.id)});
    return {products:report.products.map((p)=>({productId:p.productId,article:p.article,before:p.before,after:p.after,changed:p.changed,
      blockers:report.blockers.filter((b)=>b.productId===p.productId).map((b)=>b.code)})),unexamined:rows[0].total-rows.length};
  });
}
async function apply(config,input,options={}){
  command(input,true);const {previewToken,...request}=input;
  if(typeof previewToken!=='string'||!/^[a-f0-9]{64}$/.test(previewToken))c.invalid();
  const context=createMutationContext(options.mutationContext);
  return runAccessAdminMutation({databasePool:options.databasePool || pool,actorUserId:context.actorUserId,requiredPermission:'export_templates.publish',createError:c.error,
    operation:async(client)=>{
      await assertActorStillAuthorized(client,context.actorUserId,'export_templates.manage',c.error);
      await assertActorStillAuthorized(client,context.actorUserId,'exports.view',c.error);
      await publication.administrator(client,context.actorUserId);
      if(input.kind==='name_rule')await assertActorStillAuthorized(client,context.actorUserId,'exports.create',c.error);
      const prior=(await client.query('SELECT id FROM magento_binding_handoffs WHERE binding_revision_id=$1 AND kind=$2 AND preview_hash=$3',[input.bindingRevisionId,input.kind,previewToken])).rows[0];
      if(prior){await editor.selected(client,config,input.bindingRevisionId);return {handoffId:prior.id,alreadyApplied:true};}
      const binding=await editor.selected(client,config,input.bindingRevisionId);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${binding.installationKey}`]);
      await client.query('SELECT id FROM products WHERE id=ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE',[input.productIds]);
      await client.query('SELECT public_product_identity_id FROM magento_name_sync_states WHERE origin_hash=$1 AND public_product_identity_id IN (SELECT public_product_identity_id FROM products WHERE id=ANY($2::int[])) ORDER BY public_product_identity_id FOR SHARE',[binding.originHash,input.productIds]);
      const report=await inspect(client,config,request);
      if(c.hash({input:request,report})!==previewToken||report.blockers.length)throw c.error(409,'MAGENTO_CONTROLLED_ACTION_STALE','Repeat reviewed action',{blockers:report.blockers});
      const selected=report.products.filter((p)=>input.kind!=='name_rule'||p.changed);
      const handoffId=await handoff.record(client,context,report.revision,input.kind,previewToken,{reason:input.reason.trim(),products:report.products},
        selected.map((p)=>({...p,reason:input.kind==='name_rule'?'name_rule':'reviewed_resync'})));
      if(input.kind==='name_rule')for(const item of selected){
        await client.query('UPDATE products SET magento_name_override=$2::jsonb,magento_name_review_required=FALSE WHERE id=$1',[item.productId,JSON.stringify({generated:item.generated,values:item.after})]);
        const [state]=await readFullProductStates(client,[item.productId],{lock:true});await advanceFullProductRevision(client,item.productId,state.revision);
        await auditName(client,context.actorUserId,{id:item.productId},'amber_changed',{before:item.before,after:item.after,source:'reviewed_binding_name_rule'});
        const generation=(await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[item.publicIdentityId])).rows[0]?.desired_generation;
        if(generation)await client.query("UPDATE magento_binding_handoff_items SET state='enrolled',generation=$3 WHERE handoff_id=$1 AND product_id=$2",[handoffId,item.productId,generation]);
      }
      await writeAuditEvent(client,{mutationContext:context,eventKey:`magento_binding.${input.kind}_reviewed`,subjectType:'magento_binding_handoff',subjectId:handoffId,
        details:{previewToken,productCount:selected.length,reason:input.reason.trim()}});
      return {handoffId,alreadyApplied:false};
    }});
}
module.exports={preview,apply,candidates};
