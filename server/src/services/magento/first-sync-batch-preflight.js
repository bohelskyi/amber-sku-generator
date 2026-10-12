const c=require('./binding-contract');
const first=require('./first-sync.service');
const {fieldKey}=require('./first-sync-progress-plan');
const {SOURCE_KEYS,source}=require('./first-sync-source-snapshot');
const MAX_PRODUCTS=10;
function command(input) {
  c.command(input,['bindingRevisionId','expectedDefinitionHash','items']);c.identity(input.bindingRevisionId);
  if(!/^[a-f0-9]{64}$/.test(input.expectedDefinitionHash||'') || !Array.isArray(input.items)
    || !input.items.length || input.items.length>MAX_PRODUCTS || Object.keys(input.items).length!==input.items.length)c.invalid();
  for(const item of input.items) {
    c.command(item,['sku','expectedProduct','remoteProductId','fields']);
    if(typeof item.sku!=='string'||!item.sku.trim()||item.sku.length>256||/[\u0000-\u001f\u007f]/.test(item.sku)
      || !Number.isSafeInteger(item.remoteProductId)||item.remoteProductId<=0)c.invalid();
    c.command(item.expectedProduct,SOURCE_KEYS);
    if(!Array.isArray(item.fields)||!item.fields.length||item.fields.length>8
      || Object.keys(item.fields).length!==item.fields.length)c.invalid();
    for(const f of item.fields) {
      c.command(f,['target','scope','local','remote']);
      if(!['target','scope'].every(k=>typeof f[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(f[k])))c.invalid();
    }
    if(new Set(item.fields.map(fieldKey)).size!==item.fields.length)c.invalid();
  }
  if(new Set(input.items.map(i=>i.sku)).size!==input.items.length)c.invalid();
}
function sameValue(field,expected,actual) {
  if(['meta_title','meta_description'].includes(field.target))return typeof expected==='string'&&expected===actual;
  const scale=field.target==='price'?2:3;
  const normalize=require('./first-sync-field-plan').normalizeDecimal;
  const a=normalize(expected,scale),b=normalize(actual,scale);
  return a!==null&&a===b;
}
function roundedWeight(local,remote) {
  const normalize=require('./first-sync-field-plan').normalizeDecimal;
  const l=normalize(local,3),r=normalize(remote,0);
  if(l===null||r===null||l==='0'||l.startsWith('-')||r.startsWith('-')||!l.includes('.'))return false;
  const [whole,fraction]=l.split('.'),lower=BigInt(whole),actual=BigInt(r);
  // At exact half, either nearest whole value is valid historical rounding.
  return fraction==='5' ? actual===lower||actual===lower+1n : actual===lower+(fraction[0]>='5'?1n:0n);
}
async function packetAuthority(config,input,options) {
  const client=await options.databasePool.connect(),gate=require('../full-product-cutover-gate');
  try {
    await client.query('BEGIN');
    const access=require('../access-admin-transaction');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[access.APPLICATION_USER_ADMIN_LOCK_KEY]);
    await access.assertActorStillAuthorized(client,options.actorUserId,'export_templates.publish',c.error);
    await gate.enterExisting(client);
    const revision=await require('./binding.service').readRevisionOnClient(client,input.bindingRevisionId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${revision.installationKey}`]);
    const current=(await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
      AND state='published' ORDER BY version_number DESC LIMIT 1`,[revision.installationKey])).rows[0];
    await require('./binding-publication').administrator(client,options.actorUserId);
    if(current?.id!==revision.id || revision.state!=='published'||revision.originHash!==c.originHash(config.baseUrl)
      || revision.definitionHash!==input.expectedDefinitionHash)throw c.error(409,'BATCH_BINDING_CHANGED','Опубліковані відповідності змінилися.');
  }finally{await gate.rollback(client).catch(()=>{});await gate.release(client).catch(()=>{});client.release();}
}
async function inspectItem(config,input,item,options) {
  const boundary=require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config,{sku:item.sku,bindingRevisionId:input.bindingRevisionId},options,async state=>{
    const {observation,report}=await boundary.observe(config,{sku:state.publicSku,bindingRevisionId:input.bindingRevisionId},options);
    const p=observation.amber.product,blockers=[];
    const block=(code,target,scope)=>blockers.push({code,...(target?{target,scope}:{})});
    if(p.public_sku!==item.sku || observation.raw?.sku!==item.sku || observation.raw?.id!==item.remoteProductId)block('BATCH_IDENTITY_CHANGED');
    if(c.hash(source(p))!==c.hash(item.expectedProduct))block('BATCH_PRODUCT_CHANGED');
    if(observation.amber.compiled.hash!==input.expectedDefinitionHash)block('BATCH_DEFINITION_CHANGED');
    if(p.status!=='active'||p.corrected_to_product_id!=null||p.is_test_product===true||Number(p.exclude_from_export)!==0
      || p.exportState?.route!=='normal'||p.exportState.business_exclusion_state!=='none'
      || p.exportState.recount_compatibility_excluded||p.exportState.independentExclusion===true)block('BATCH_LIFECYCLE_NOT_NORMAL');
    if(report.evaluation?.ready!==true || report.syncEligibility?.eligible!==true || report.sendable!==true)
      block('BATCH_PRODUCT_PAYLOAD_NOT_READY');
    const base=await first.inspect(config,observation,options);
    if(base.mode!=='first') {
      return {sku:item.sku,mode:base.mode,status:base.mode==='ordinary'&&!blockers.length?'ordinary_preview_required':'blocked',
        blockers:[...blockers,...base.blockers],...(base.historyReview?{historyReview:base.historyReview}:{}),readyForApply:false};
    }
    const choices=[];
    for(const wanted of item.fields) {
      const row=base.fields.find(f=>fieldKey(f)===fieldKey(wanted));
      const meta=base.projection.projection.find(f=>fieldKey(f)===fieldKey(wanted));
      const seo=['meta_title','meta_description'].includes(wanted.target)&&['all','en'].includes(wanted.scope);
      const price=wanted.target==='price'&&wanted.scope==='all';
      const weight=meta?.persistence==='weight'&&wanted.scope==='all';
      if(!seo&&!price&&!weight){block('BATCH_FIELD_NOT_APPROVED',wanted.target,wanted.scope);continue;}
      if(!row||!row.local.known||!row.remote.known||!sameValue(wanted,wanted.local,row.local.value)
        || !sameValue(wanted,wanted.remote,row.remote.value)) {block('BATCH_FIELD_CHANGED',wanted.target,wanted.scope);continue;}
      const priorSeoPending=seo&&base.first.progress?.fields.some(f=>fieldKey(f)===fieldKey(wanted)&&f.state==='seo_pending_initial_readback');
      if(!priorSeoPending&&sameValue(wanted,row.local.value,row.remote.value))continue;
      if(weight&&!roundedWeight(row.local.value,row.remote.value)){block('BATCH_WEIGHT_NOT_ROUNDING_ONLY',wanted.target,wanted.scope);continue;}
      if(!row.canKeepLocal){block('BATCH_LOCAL_CHOICE_UNAVAILABLE',wanted.target,wanted.scope);continue;}
      choices.push({target:wanted.target,scope:wanted.scope,choice:'keep_local'});
    }
    let planned=null;
    if(!blockers.length && choices.length) {
      const inspected=await first.prepareDecision(config,base,choices,options);planned=inspected.prepared;
      if(choices.some(d=>{const r=planned.rows.find(f=>fieldKey(f)===fieldKey(d));return !r||r.received||r.record.state!=='pending_outward_confirmation';}))
        block('BATCH_LOCAL_CHOICE_UNAVAILABLE');
      const client=await options.databasePool.connect(),gate=require('../full-product-cutover-gate');
      try {
        await client.query('BEGIN');
        await require('./sync-job-transaction').revalidate(client,config,state,options);
        await require('./binding-publication').administrator(client,options.actorUserId);
        const fresh=await require('./first-sync-eligibility').readFirstSyncEligibility(client,config,observation);
        if(fresh.mode!=='first'||fresh.evidenceHash!==base.first.evidenceHash)block('BATCH_FIRST_SYNC_EVIDENCE_CHANGED');
        const proof=require('./first-sync-local-authority').mint(inspected,choices);
        await require('./first-sync-local-authority').validate(client,proof,{key:base.first.key,
          fields:planned.rows.map(r=>r.record)},fresh.progress);
      }finally{await gate.rollback(client).catch(()=>{});await gate.release(client).catch(()=>{});client.release();}
    }
    return {sku:item.sku,mode:base.mode,status:blockers.length?'blocked':!choices.length?'no_change':'first_sync_choices',
      blockers,remainingBlockers:planned?.blockers||base.blockers,readyForApply:!blockers.length&&choices.length>0,
      readyForOutboundAfterChoices:planned?.readyForOutbound===true,
      initialImports:(planned?.rows||base.prepared.rows).filter(r=>!r.received&&['imported','name_received'].includes(r.record.state))
        .map(r=>({target:r.target,scope:r.scope,before:r.local,after:r.record.after})),
      ...(!blockers.length&&choices.length?{applyInput:{sku:item.sku,bindingRevisionId:input.bindingRevisionId,previewToken:base.previewToken,
        choices:first.decisions({choices})}}:{})};
  });
}
async function preflight(config,input,options={}) {
  command(input);options={...options,databasePool:options.databasePool||require('../../db/pool'),
    actorUserId:options.mutationContext?.actorUserId||options.actorUserId};
  await packetAuthority(config,input,options);
  const results=[];let globalFailure=null;
  for(const item of input.items) {
    try{results.push(await inspectItem(config,input,item,options));}
    catch(e){
      const code=typeof e.code==='string'&&/^[A-Z0-9_]{1,160}$/.test(e.code)?e.code:'BATCH_PREVIEW_FAILED';
      results.push({sku:item.sku,status:'blocked',readyForApply:false,blockers:[{code}]});
      if([401,403].includes(e.statusCode)||['ADMIN_PERMISSION_REVOKED','ACTOR_NOT_ACTIVE','MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED',
        'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED','MAGENTO_SYNC_BINDING_CHANGED'].includes(code)){globalFailure=code;break;}
    }
  }
  if(!globalFailure)try{await packetAuthority(config,input,options);}catch(e){globalFailure=e.code||'BATCH_AUTHORITY_CHANGED';}
  if(globalFailure) {
    for(const r of results)if(r.readyForApply){r.readyForApply=false;r.readyForOutboundAfterChoices=false;r.status='blocked';
      delete r.applyInput;r.blockers.push({code:globalFailure});}
    for(const item of input.items.slice(results.length))results.push({sku:item.sku,status:'not_checked',readyForApply:false,
      blockers:[{code:'BATCH_ABORTED_AFTER_GLOBAL_CHANGE'}]});
  }
  return {contract:'first-sync-local-authority-batch-v1',readOnly:true,bindingRevisionId:input.bindingRevisionId,
    results,counts:{total:results.length,readyForApply:results.filter(r=>r.readyForApply).length,
    blocked:results.filter(r=>r.status==='blocked').length,notChecked:results.filter(r=>r.status==='not_checked').length,
    noChange:results.filter(r=>r.status==='no_change').length,
    ordinaryPreviewRequired:results.filter(r=>r.status==='ordinary_preview_required').length},
    ...(globalFailure?{globalFailure}:{}),
    execution:'Per-product atomic choices only; no enqueue, adoption or Magento writes performed.'};
}
module.exports={preflight,command,source,roundedWeight,MAX_PRODUCTS};
