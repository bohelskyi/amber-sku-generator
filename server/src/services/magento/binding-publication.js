const pool = require('../../db/pool');
const c = require('./binding-contract');
const editor = require('./integration-editor.service');
const service = require('./binding.service');
const repository = require('./binding-repository');
const handoff = require('./binding-handoff');
const { evaluate } = require('./binding-evidence-products');
const { planPreview, previewProduct, preparePreview } = require('./sync-preview');
const { loadSourceEvidence } = require('../export-templates/source-references');
const scope = require('./publication-scope');
const { ruleProof } = require('./integration-successor');
const { boundedGet, previewView } = require('./integration-readiness');
const { syncEligibility } = require('./sync-eligibility');
const { createMutationContext } = require('../../audit/mutation-context');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');
const { same } = require('./name-reconciliation');
const { bindingKey } = require('./binding-validation');
const { readResponseBytes } = require('./client');
const MAX_PRODUCTS=scope.LIMITS.products;
const clean=(value)=>JSON.parse(JSON.stringify(value));
const names=(mapped)=>({all:mapped.base.name,en:mapped.english.name});
const scopes=(r)=>r.bindings.routes.filter((v)=>v.enabled && v.reviewState==='approved').map((v)=>v.routeKey);
function command(input,apply=false){
  c.command(input,['bindingRevisionId','expectedRevision','expectedCurrentId'],['representatives','currentProductIds',...(apply?['previewToken','ackCoverageLoss','coverageReason']:[])]);
  c.identity(input.bindingRevisionId);c.counter(input.expectedRevision);if(input.expectedCurrentId!==null)c.identity(input.expectedCurrentId);
  if(input.representatives && (!Array.isArray(input.representatives)||input.representatives.length>64))c.invalid();
  for(const sample of input.representatives || [])c.command(sample,['product'],['pricingDecision']);
  if(input.currentProductIds && (!Array.isArray(input.currentProductIds)||input.currentProductIds.length>10
    || input.currentProductIds.some((id)=>!Number.isSafeInteger(id)||id<=0)))c.invalid();
}
async function context(client,config,input,scanOptions={}){
  const draft=await editor.selected(client,config,input.bindingRevisionId);
  const currentRow=await repository.current(client,draft.installationKey);
  if(draft.state!=='draft'||draft.revision!==c.counter(input.expectedRevision)||(currentRow?.id || null)!==input.expectedCurrentId)
    throw c.error(409,'MAGENTO_BINDING_CONFLICT','Draft/current publication changed');
  const current=currentRow?await service.readRevisionOnClient(client,currentRow.id):null;
  const next=await editor.compiledRevision(client,draft),old=current?await editor.compiledRevision(client,current):null;
  const evidence=await loadSourceEvidence(client,next.compiled.definition);
  const validation=await service.validateDraftOnClient(client,draft.id);
  const local={draft,current,next,old,evidence,validation};
  if(scanOptions.metadataOnly)return local;
  return {...local,...await scope.scan(client,local,scanOptions)};
}
// Reuse the planner's translations/diagnostics for declared local delivery.
// Remote sendability is proved separately by bounded real GET-only previews.
function projection(amber,product,nodes){
  const mapped=evaluate(amber,product);
  const report=planPreview({...amber,product},amber.revision.schema,null,nodes,{domainEvidence:{failures:[]},prepared:amber.prepared});
  const currentKnown=Boolean(amber.nameState?.remote_product_id);
  const eligibility=syncEligibility(product,currentKnown?{sku:product.public_sku}:null);
  const eligible=eligibility.eligible;
  const covered=eligible && mapped.ready && report.attributeSet.status==='resolved_authoritative'
    && report.attributes.every((a)=>a.diagnostics.length===0)
    && report.categories.requested.every((r)=>r.authority==='authoritative');
  const owned=new Set(amber.revision.bindings.policies.filter((p)=>p.reviewState==='approved' && p.policy==='authoritative_create_update').map((p)=>p.bindingKey));
  const fields=report.diff.filter((d)=>owned.has(d.persistedDecision?.bindingKey)
    || amber.revision.bindings.attributes.some((a)=>a.routeKey===report.attributeSet.routeKey && a.rowId==='base' && a.target===d.target && owned.has(a.bindingKey)))
    .map((d)=>({target:d.target,value:d.candidate,
      destination:amber.revision.bindings.attributes.find((a)=>a.routeKey===report.attributeSet.routeKey && a.rowId==='base' && a.target===d.target)?.attributeCode ?? null}));
  const english=amber.revision.bindings.attributes.filter((a)=>a.routeKey===report.attributeSet.routeKey && a.rowId==='english' && owned.has(a.bindingKey))
    .map((a)=>({target:a.target,destination:a.attributeCode,value:mapped.english[a.target] ?? null}));
  const categories=owned.has(bindingKey(report.attributeSet.routeKey || '', 'base', 'categories'))?report.categories.requested.map((r)=>({id:r.categoryId,path:r.requestedPath})):[];
  return {covered,routeKey:report.attributeSet.routeKey,names:names(mapped),generated:mapped.generatedNames,
    signature:c.hash(clean({set:report.attributeSet.selected?.id ?? null,fields,english,categories})),
    blockers:[...eligibility.reasons.map((r)=>({code:r.code})),...(!mapped.ready?[{code:'PRODUCT_EVALUATION_NOT_READY'}]:[]),
      ...report.attributes.flatMap((a)=>a.diagnostics.map((code)=>({code,target:a.target}))) ]};
}
function impact(local,nodes){
  const lostRoutes=local.current?scopes(local.current).filter((r)=>!scopes(local.draft).includes(r)):[];
  const affected=[],lostProducts=[],preservedNames=[],projections=[];
  for(const product of local.nextProducts){
    if(local.deadline)scope.checkDeadline(local.deadline);
    const state=local.states.find((s)=>String(s.public_product_identity_id)===String(product.public_product_identity_id)) || null;
    const oldProduct=local.oldProducts.find((p)=>p.id===product.id);
    const before=oldProduct?projection({...local.old,revision:local.current,nameState:state,prepared:local.preparedOld},oldProduct,nodes):null;
    const nextMapped=evaluate(local.next,product),generated=nextMapped.generatedNames;
    if(before?.names.all && before.names.en && !same(before.names,names(nextMapped))){
      product.magento_name_rule_pin={generated,values:before.names};
      preservedNames.push({productId:product.id,article:product.public_sku,before:before.names,generated});
    }
    const after=projection({...local.next,revision:local.draft,nameState:state,prepared:local.preparedNext},product,nodes);
    if(before?.covered && !after.covered)lostProducts.push({productId:product.id,article:product.public_sku,routeKey:before.routeKey,blockers:after.blockers});
    if(after.covered && (!before?.covered || before.signature!==after.signature))affected.push({productId:product.id,
      publicIdentityId:product.public_product_identity_id,article:product.public_sku,routeKey:after.routeKey,reason:before?.covered?'delivery_changed':'unblocked'});
    projections.push({productId:product.id,before,after});
  }
  return {lostRoutes,lostProducts,affected,preservedNames,projections};
}
function cachedReads(fetchImpl){
  const cache=new Map(),deadline=Date.now()+60000;
  async function snapshot(url,options){
    const response=await fetchImpl(url,options);
    try{
      // Consume within the caller's request lifetime, before its client aborts.
      // Only detached bounded bytes survive in the publication-wide cache.
      const bytes=await readResponseBytes(response);
      return {bytes,ok:response.ok,init:{status:response.status,statusText:response.statusText,
        headers:[...response.headers]}};
    }finally{
      if(response.body && !response.body.locked)await response.body.cancel().catch(()=>{});
    }
  }
  return async(url,options)=>{
    if(options.method!=='GET')c.invalid();if(Date.now()>=deadline)throw c.error(422,'MAGENTO_DISCOVERY_LIMIT','Read deadline exceeded');
    const key=String(url);
    if(!cache.has(key))cache.set(key,snapshot(url,options));
    const pending=cache.get(key);
    try{
      const value=await pending;
      if(!value.ok && cache.get(key)===pending)cache.delete(key);
      return new Response([204,205,304].includes(value.init.status)?null:value.bytes,value.init);
    }catch(error){
      if(cache.get(key)===pending)cache.delete(key);
      throw error;
    }
  };
}
async function preview(config,input,options={}){
  try{return await boundedPreview(config,input,options);}catch(cause){scope.translateLimit(cause);}
}
async function boundedPreview(config,input,options={}){
  command(input);
  const deadline=Date.now()+scope.LIMITS.previewMs;
  const metadata=await editor.read(options,(client)=>context(client,config,input,{metadataOnly:true}));
  const fetchImpl=cachedReads(boundedGet(async(url,init)=>{
    scope.checkDeadline(deadline);
    return (options.fetchImpl || globalThis.fetch)(url,{...init,signal:AbortSignal.any([
      ...(init.signal?[init.signal]:[]),AbortSignal.timeout(Math.max(1,deadline-Date.now()))])});
  }));
  const observation=await (options.discover || editor.discovery)(config,{fetchImpl});
  const result={lostRoutes:[],lostProducts:[],affected:[],preservedNames:[],projections:[]};
  const projectionDigest=require('node:crypto').createHash('sha256');
  const samples=new Map(),firstByRoute=new Map();
  let preparedOld,preparedNext;
  const local=await editor.read(options,(client)=>context(client,config,input,{deadline,onPage:async(page)=>{
    preparedOld ??= page.old?preparePreview({...page.old,revision:page.current},page.current.schema):null;
    preparedNext ??= preparePreview({...page.next,revision:page.draft},page.draft.schema);
    const change=impact({...page,preparedOld,preparedNext,deadline},observation.categories);
    for(const key of ['lostProducts','affected','preservedNames'])result[key].push(...change[key]);
    // Debug excerpt only; the digest binds every projection, including later pages.
    for(const p of change.projections){projectionDigest.update(c.hash(p));if(result.projections.length<64)result.projections.push(p);}
    for(const p of page.nextProducts){
      const affected=change.affected.find(a=>a.productId===p.id);
      if((input.currentProductIds || []).includes(p.id) || (affected && !firstByRoute.has(affected.routeKey))){
        if(affected && !firstByRoute.has(affected.routeKey))firstByRoute.set(affected.routeKey,p.id);
        samples.set(p.id,{product:p,nameState:page.states.find(s=>String(s.public_product_identity_id)===String(p.public_product_identity_id)) || null});
        if(samples.size>74)scope.limit('representative_routes');
      }
    }
    scope.checkEvidence(result);
  }}));
  if(metadata.draft.revision!==local.draft.revision || c.hash(observation.schema)!==local.draft.schemaFingerprint)
    throw c.error(409,'MAGENTO_BINDING_OBSERVATION_CHANGED','Prepare a draft with fresh Magento metadata');
  result.lostRoutes=local.current?scopes(local.current).filter(r=>!scopes(local.draft).includes(r)):[];
  const validation=local.validation;
  const newRoutes=scopes(local.draft).filter((route)=>!local.current || !scopes(local.current).includes(route)
    || local.current.bindings.routes.find((r)=>r.routeKey===route)?.setId!==local.draft.bindings.routes.find((r)=>r.routeKey===route)?.setId
    || ruleProof(local.old.compiled.definition,route.split(/[.:]/)[0],'base','attribute_set_code')!==ruleProof(local.next.compiled.definition,route.split(/[.:]/)[0],'base','attribute_set_code'));
  const checked=[];
  for(const sample of input.representatives || []){
    const report=await (options.createPreview || editor.prospectivePreview)(config,{bindingRevisionId:local.draft.id,...sample},
      {...options,fetchImpl,discover:async()=>observation});
    checked.push({kind:'create',...report});
  }
  const ids=new Set(input.currentProductIds || []);
  for(const [route,id] of firstByRoute)if(![...ids].some(productId=>result.affected.find(a=>a.productId===productId)?.routeKey===route))ids.add(id);
  if(ids.size>64)throw c.error(422,'MAGENTO_PUBLICATION_LIMIT','Too many representative routes');
  for(const productId of ids){
    const sample=samples.get(productId);if(!sample)c.invalid();const {product,nameState}=sample;
    const report=await (options.currentPreview || previewProduct)(config,{databasePool:options.databasePool || pool,fetchImpl,
      bindingRevisionId:local.draft.id,productId,discover:async()=>observation.schema,
      readAmber:async()=>({...local.next,revision:local.draft,product,nameState})});
    checked.push({kind:'current',productId,...previewView(report)});
  }
  const missingCreate=newRoutes.filter((route)=>!checked.some((p)=>p.kind==='create' && p.routeKey===route && p.sendable));
  const blockers=[...(!validation.valid?validation.diagnostics:[]),...missingCreate.map((routeKey)=>({code:'REPRESENTATIVE_CREATE_REQUIRED',routeKey})),
    ...checked.filter((p)=>p.kind==='current' && result.affected.some((a)=>a.productId===p.productId) && !p.sendable).map((p)=>({code:'AFFECTED_CURRENT_PREVIEW_BLOCKED',productId:p.productId}))];
  const proof={localHash:local.localHash,validation:validation.diagnostics,schemaHash:c.hash(observation.schema),nodes:observation.categories,
    ...result,projectionDigest:projectionDigest.digest('hex'),checked:checked.map(({observedAt,...p})=>{void observedAt;return p;}),blockers};
  const previewToken=c.hash(clean(proof));
  const response={bindingRevisionId:local.draft.id,expectedRevision:local.draft.revision,expectedCurrentId:local.current?.id || null,
    previewToken,totalProducts:local.totalProducts,lostRoutes:result.lostRoutes,lostProducts:result.lostProducts,
    affected:result.affected,preservedNames:result.preservedNames,checked,blockers};
  scope.checkEvidence(response);scope.checkDeadline(deadline);
  return {...response,...(options.internal?{internal:{local,proof}}:{})};
}
async function administrator(client,id){
  if(!(await client.query(`SELECT 1 FROM user_role_assignments a JOIN roles r ON r.id=a.role_id
    WHERE a.application_user_id=$1 AND a.revoked_at IS NULL AND r.role_key='administrator' AND r.status='active'`,[id])).rowCount)
    throw c.error(403,'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED','Administrator acknowledgement required');
}
async function publish(config,input,options={}){
  command(input,true);const {previewToken,ackCoverageLoss,coverageReason,...request}=input;
  if(typeof previewToken!=='string'||!/^[a-f0-9]{64}$/.test(previewToken))c.invalid();
  const contextActor=createMutationContext(options.mutationContext);
  // Recovery returns the original committed receipt without remote reads or
  // reenrollment, even after a later publication supersedes this one.
  const prior=(await (options.databasePool || pool).query(`SELECT id,preview_hash FROM magento_binding_handoffs WHERE binding_revision_id=$1 AND kind='publication'`,[input.bindingRevisionId])).rows[0];
  if(prior){
    if(prior.preview_hash!==previewToken)throw c.error(409,'MAGENTO_PUBLICATION_STALE','Different publication receipt');
    return runAccessAdminMutation({databasePool:options.databasePool || pool,actorUserId:contextActor.actorUserId,requiredPermission:'export_templates.publish',createError:c.error,
      operation:async(client)=>{
        await assertActorStillAuthorized(client,contextActor.actorUserId,'export_templates.manage',c.error);
        await assertActorStillAuthorized(client,contextActor.actorUserId,'exports.view',c.error);
        return {revision:await editor.selected(client,config,input.bindingRevisionId),handoffId:prior.id,alreadyApplied:true};
      }});
  }
  const fresh=await preview(config,request,{...options,internal:true});
  if(fresh.previewToken!==previewToken || fresh.blockers.length)throw c.error(409,'MAGENTO_PUBLICATION_STALE','Repeat publication review',{blockers:fresh.blockers});
  const loss=fresh.lostRoutes.length || fresh.lostProducts.length;
  if(loss && (ackCoverageLoss!==true || typeof coverageReason!=='string' || coverageReason.trim().length<3 || coverageReason.length>2000))
    throw c.error(422,'MAGENTO_COVERAGE_ACK_REQUIRED','Explicit acknowledgement and explanation of exact lost coverage required');
  return runAccessAdminMutation({databasePool:options.databasePool || pool,actorUserId:contextActor.actorUserId,requiredPermission:'export_templates.publish',createError:c.error,
    operation:async(client)=>{
      const localDeadline=Date.now()+scope.LIMITS.localMs;
      await assertActorStillAuthorized(client,contextActor.actorUserId,'export_templates.manage',c.error);
      await assertActorStillAuthorized(client,contextActor.actorUserId,'exports.view',c.error);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${fresh.internal.local.draft.installationKey}`]);
      const completed=(await client.query("SELECT id,preview_hash FROM magento_binding_handoffs WHERE binding_revision_id=$1 AND kind='publication'",[input.bindingRevisionId])).rows[0];
      if(completed){if(completed.preview_hash!==previewToken)c.invalid();return {revision:await service.readRevisionOnClient(client,input.bindingRevisionId),handoffId:completed.id,alreadyApplied:true};}
      // Brief local publication boundary also prevents catalog/product phantoms.
      // No network calls occur under these locks.
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='15s'");
      // Product before full state, then shared names. The lifecycle gate and
      // installation/access coordination precede this existing table boundary.
      await client.query('LOCK TABLE categories,questions,options,sku_schema_versions,products,product_full_export_state,magento_name_sync_states,magento_test_deletions IN SHARE MODE');
      const local=await context(client,config,request,{deadline:localDeadline});
      if(local.localHash!==fresh.internal.local.localHash)throw c.error(409,'MAGENTO_PUBLICATION_STALE','Local publication evidence changed');
      if(loss)await administrator(client,contextActor.actorUserId);
      const revision=await service.publishDraftOnClient(client,contextActor,input.bindingRevisionId,{expectedRevision:input.expectedRevision,expectedCurrentId:input.expectedCurrentId});
      for(let offset=0;offset<fresh.preservedNames.length;offset+=scope.LIMITS.page){scope.checkDeadline(localDeadline);await client.query(`INSERT INTO magento_binding_name_pins(binding_revision_id,product_id,generated,effective_names)
        SELECT $1,v."productId",v.generated,v.before FROM jsonb_to_recordset($2::jsonb)
          AS v("productId" integer,generated jsonb,before jsonb)`,[revision.id,JSON.stringify(fresh.preservedNames.slice(offset,offset+scope.LIMITS.page))]);}
      const evidence={lostRoutes:fresh.lostRoutes,lostProducts:fresh.lostProducts,affected:fresh.affected,preservedNames:fresh.preservedNames,
        ackCoverageLoss:Boolean(loss && ackCoverageLoss),coverageReason:loss?coverageReason.trim():null,currentId:input.expectedCurrentId};
      const handoffId=await handoff.record(client,contextActor,revision,'publication',previewToken,evidence,fresh.affected,{deadline:localDeadline});
      await writeAuditEvent(client,{mutationContext:contextActor,eventKey:'magento_binding.publication_reviewed',subjectType:'magento_binding',subjectId:revision.id,
        details:{previewToken,handoffId,affectedCount:fresh.affected.length,preservedNameCount:fresh.preservedNames.length,coverageLoss:loss?evidence:null}});
      scope.checkDeadline(localDeadline);return {revision,handoffId,alreadyApplied:false};
    }}).catch(scope.translateLimit);
}
module.exports={MAX_PRODUCTS,projection,impact,context,preview,publish,administrator,cachedReads};
