// Explicit local Administrator completion. This is an attestation of historical
// facts, NOT a frozen-SKU proof, delivery admission or remote-write authority.
const c=require('./binding-contract');
const legacy=require('./first-sync-legacy-inputs');
const schemas=require('../sku-schema.service');
const configurations=require('../product/characteristic-config');
const information=require('../product-information.service');
const previews=require('./sync-preview-db');
const evaluator=require('./binding-evidence-products');
const {projectFirstSyncFields}=require('./first-sync-projection');
const {prepareProgress,TERMINAL}=require('./first-sync-progress-plan');
const {getRuleDependencies}=require('../../utils/rules');
const {isQuestionVisibleForSku}=require('../product/product-answers');
const {inspectNonSkuAnswer}=require('../product/product-validation');
const {normalizeBindings}=require('./binding-validation');
const lifecycle=require('../full-product-export.service');
const ledger=require('./first-sync-ledger');
const cutover=require('./first-sync-cutover-admission');
const historyAdmission=require('./first-sync-history-admission');
const eligibility=require('./first-sync-eligibility');
const {writeAuditEvent}=require('../../audit/audit-events');
const gate=require('../full-product-cutover-gate');
const EVENT='product.magento_legacy_inputs_completed';
const ATTESTATION='processing_not_encoded_in_historical_sku';
const fail=code=>{throw c.error(409,'MAGENTO_LEGACY_INPUT_'+code,'Потрібна актуальна перевірка відсутніх характеристик старого сувеніра.');};
const present=value=>value!==undefined&&value!==null&&String(value).trim()!=='';
const pair=e=>({all:e.base?.name,en:e.english?.name});
function command(input,applying=false){
  c.command(input,['sku','bindingRevisionId','processingValueId','attestation','reason'],applying?['previewToken']:[]);
  c.identity(input.bindingRevisionId);
  if(typeof input.sku!=='string'||!input.sku.trim()||input.sku.length>255||/[\u0000-\u001f\u007f]/.test(input.sku)
    ||!['string','number'].includes(typeof input.processingValueId)||!/^(0|[1-9][0-9]*)$/.test(String(input.processingValueId))
    ||!Number.isSafeInteger(Number(input.processingValueId))||Number(input.processingValueId)>2147483647
    ||input.attestation!==ATTESTATION||typeof input.reason!=='string'||input.reason.trim()!==input.reason
    ||input.reason.length<10||input.reason.length>500||/[\u0000-\u001f\u007f]/.test(input.reason)
    ||applying&&(typeof input.previewToken!=='string'||!/^[a-f0-9]{64}$/.test(input.previewToken)))c.invalid();
}
const selection=input=>({sku:input.sku,bindingRevisionId:input.bindingRevisionId,
  processingValueId:String(input.processingValueId),attestation:input.attestation,reason:input.reason});
const optionsFor=options=>({...options,databasePool:options.databasePool||require('../../db/pool'),
  actorUserId:options.mutationContext?.actorUserId||options.actorUserId});
async function administrator(client,options){
  await require('./binding-publication').administrator(client,options.actorUserId);
  for(const permission of ['export_templates.manage','export_templates.publish','exports.view','products.recount']) {
    await require('../access-admin-transaction').assertActorStillAuthorized(client,options.actorUserId,permission,c.error,{readOnly:true});
  }
}
function assertReview(first){
  if(first.mode==='ordinary'||first.progress?.session.completed_at)fail('ALREADY_RECEIVED');
  if(first.admissionGuards.protectedWork||first.admissionGuards.otherOrigin)fail('PROTECTED_WORK');
  // Local-only completion is allowed before admission whether the history review is
  // blocked by changed delivery history or still available after a CSV-retired local
  // revision (first-sync-cutover-admission csvUndelivered); it never admits by itself.
  if(first.mode!=='first'&&!(first.mode==='review'&&first.blockers.length===1
    &&first.blockers[0].code==='FIRST_SYNC_HISTORY_REVIEW_REQUIRED'
    &&(first.historyReviewAssessment?.code==='FIRST_SYNC_DELIVERY_HISTORY_CHANGED'
      ||first.historyReviewAssessment?.status==='available')&&!first.progress))fail('HISTORY_REVIEW_REQUIRED');
}
async function prepareOnClient(client,{config,observation,state,input,options,lock=false}){
  await administrator(client,options);
  const product=observation.amber.product,previous=product.details?.answers || {};
  // The Magento observation may have outlived its Amber snapshot. Compare the
  // current local rows and publication in this same read/commit snapshot.
  const currentProduct=(await client.query('SELECT p.*,i.public_sku FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1',[state.productId])).rows[0];
  const currentFull=(await client.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[state.productId])).rows[0];
  const clean=value=>JSON.parse(JSON.stringify(value));
  if(!currentProduct||!currentFull||c.hash(clean({product:currentProduct,lifecycle:currentFull}))!==state.amberHash
    ||Object.keys(currentProduct).some(key=>!Object.hasOwn(product,key))
    ||c.hash(clean(Object.fromEntries(Object.keys(currentProduct).map(key=>[key,product[key]]))))!==c.hash(clean(currentProduct)))fail('SOURCE_CHANGED');
  const current=(await client.query("SELECT id FROM magento_binding_revisions WHERE installation_key=$1 AND state='published' ORDER BY version_number DESC LIMIT 1",[state.revision.installationKey])).rows[0];
  const selected=await require('./binding.service').readRevisionOnClient(client,input.bindingRevisionId);
  if(current?.id!==input.bindingRevisionId||c.hash(clean(selected))!==state.bindingHash
    ||c.hash(clean(observation.amber.revision))!==state.bindingHash)fail('BINDING_CHANGED');
  if(!legacy.isLegacySv(product)||product.public_sku!==product.full_sku||product.public_sku!==state.publicSku
    ||Number(product.id)!==state.productId||String(product.public_product_identity_id)!==String(state.publicIdentityId)
    ||product.status!=='active'||product.corrected_from_product_id||product.corrected_to_product_id
    ||!observation.raw||observation.raw.sku!==state.publicSku||!Number.isSafeInteger(observation.raw.id)||observation.raw.id<1)fail('IDENTITY_UNPROVEN');
  if(lock)await client.query('LOCK TABLE categories,questions,options,price_scenarios,price_weight_bands,price_matrix,price_modifiers,sku_schema_versions,sku_schema_questions,sku_schema_options,sku_registry IN SHARE MODE NOWAIT');
  const origin=(await client.query(`SELECT p.created_at,s.created_at schema_created_at,s.published_by_user_id,s.version,s.marker,
    c.sku_publication_mode,i.origin FROM products p JOIN sku_schema_versions s ON s.id=p.sku_schema_version_id
    JOIN categories c ON c.code=p.category JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`,[product.id])).rows[0];
  const born=origin?.created_at==null?NaN:new Date(origin.created_at).getTime();
  const captured=origin?.schema_created_at==null?NaN:new Date(origin.schema_created_at).getTime();
  if(!origin||origin.origin!=='legacy'||origin.sku_publication_mode!=='legacy_bootstrap'||origin.published_by_user_id!==null
    ||Number(origin.version)!==1||origin.marker!==''||!Number.isFinite(born)||!Number.isFinite(captured)||born>=captured)fail('BOOTSTRAP_PROVENANCE_REQUIRED');
  const frozen=await schemas.getSchemaVersionById(product.sku_schema_version_id,client);
  const encoding=legacy.inspectBootstrapEncoding(product,frozen);
  if(encoding.reconstructable)fail('ENCODED_CHARACTERISTIC_REQUIRES_CORRECTION');
  const owner=(await client.query('SELECT first_product_id FROM sku_registry WHERE full_sku=$1',[product.full_sku])).rows;
  if(owner.length!==1||Number(owner[0].first_product_id)!==product.id)fail('IDENTITY_UNPROVEN');
  if((await client.query("SELECT id FROM correction_requests WHERE source_product_id=$1 AND status IN ('pending','in_progress') LIMIT 1",[product.id])).rows.length)fail('ACTIVE_CORRECTION_REQUEST');
  if(present(previous.stone_processing))fail('MISSING_ONLY');
  const first=await eligibility.readFirstSyncEligibility(client,config,observation);assertReview(first);
  const history=await require('./recovery-history').read(client,product.id);
  if(!history.complete||history.hasRecount||history.identityChanged||history.issues.length||history.products.length!==1)fail('IDENTITY_UNPROVEN');
  const configuration=await configurations.readCharacteristicConfiguration(client,'SV'),value=String(input.processingValueId);
  const targets=configuration.questions.filter(q=>q.key==='stone_processing'),target=targets[0];
  if(targets.length!==1||target.archived||target.input_type!=='options'
    ||!isQuestionVisibleForSku(target,previous,product.details?.isCalibrated))fail('TARGET_UNAVAILABLE');
  const candidates=target.options.filter(o=>String(o.value_id)===value);
  if(candidates.length!==1||candidates[0].archived)fail('TARGET_UNAVAILABLE');
  const frozenTargets=frozen.questions.filter(q=>q.key==='stone_processing');
  const frozenOptions=frozenTargets.length===1?frozenTargets[0].options.filter(o=>String(o.value_id)===value):[];
  const rawOptions=(await client.query('SELECT q.include_in_sku,o.sku_code,o.value_id FROM questions q JOIN options o ON o.question_id=q.id WHERE q.id=$1 AND o.value_id=$2',[target.id,Number(value)])).rows;
  if(frozenOptions.length!==1||rawOptions.length!==1||![0,1].includes(rawOptions[0].include_in_sku)
    ||String(frozenOptions[0].sku_code)!==String(rawOptions[0].sku_code ?? rawOptions[0].value_id))fail('SEMANTIC_IDENTITY_CHANGED');
  const patch={stone_processing:value},prospective={...previous,...patch};
  if(inspectNonSkuAnswer(target,prospective,product.details?.isCalibrated,{previousAnswers:previous}).issue)fail('TARGET_UNAVAILABLE');
  const projection=projectFirstSyncFields({observation:{amber:observation.amber,raw:observation.raw,
    schema:observation.schema,domainEvidence:observation.domainEvidence}});
  const processing=projection.projection.find(m=>m.scope==='all'&&m.source.key==='stone_processing');
  const field=projection.fields.find(f=>f.target===processing?.target&&f.scope==='all');
  if(!processing||processing.persistence!=='characteristic'||processing.reason||processing.readReason
    ||!field?.mapping.proven||!field.remote.known||field.local.present)fail('BINDING_UNPROVEN');
  const bindings=normalizeBindings(observation.amber.revision.bindings);
  const mappings=bindings.options.filter(o=>o.reviewState==='approved'&&o.sourceKind==='semantic'&&o.amberGroup==='SV'
    &&o.questionKey==='stone_processing'&&o.valueId===value&&bindings.attributes.some(a=>a.bindingKey===o.bindingKey
      &&a.routeKey===processing.source.routeKey&&a.rowId==='base'&&a.target===processing.target&&a.reviewState==='approved'));
  if(mappings.length!==1||!mappings[0].optionId)fail('BINDING_UNPROVEN');
  if(field.remote.present&&(!['string','number'].includes(typeof field.remote.value)||String(field.remote.value)!==mappings[0].optionId))fail('REMOTE_PROCESSING_DIFFERS');
  const size=projection.projection.find(m=>m.persistence==='information'&&m.source.key==='size'&&m.scope==='all');
  const sizeField=projection.fields.find(f=>f.target===size?.target&&f.scope==='all');
  let info=null;
  if(!present(previous.size)){
    if(!size||size.reason||size.readReason||!sizeField?.mapping.proven||!sizeField.remote.known||!sizeField.remote.present
      ||typeof sizeField.remote.value!=='string'||sizeField.remote.value.trim()!==sizeField.remote.value)fail('REMOTE_SIZE_UNPROVEN');
    info=await information.prepareProductInformationOnClient(client,product,{size:sizeField.remote.value},{lockCatalog:lock});
    patch.size=info.newAnswers.size;
  }
  const keys=Object.keys(patch);
  for(const q of [...configuration.questions,...frozen.questions]){
    if(getRuleDependencies(q.visible_if_json).some(k=>keys.includes(k))
      ||(q.options || []).some(o=>[o.visible_if_json,o.hidden_if_json].some(rule=>getRuleDependencies(rule).some(k=>keys.includes(k)))))fail('DEPENDENCY_REQUIRES_REVIEW');
  }
  const scenarios=(await client.query('SELECT match_json,axis_x_key,axis_y_key FROM price_scenarios WHERE category_code=$1',['SV'])).rows;
  const modifiers=(await client.query('SELECT match_json,trigger_key FROM price_modifiers WHERE category_code=$1',['SV'])).rows;
  const axis=value=>String(value || '').split('+').map(k=>k.trim());
  if(scenarios.some(s=>[...getRuleDependencies(s.match_json),...axis(s.axis_x_key),...axis(s.axis_y_key)].some(k=>keys.includes(k)))
    ||modifiers.some(m=>[...getRuleDependencies(m.match_json),m.trigger_key].some(k=>keys.includes(k))))fail('PRICING_DEPENDENCY_REQUIRES_REVIEW');
  const before=evaluator.evaluate(observation.amber,product),saved=product.details;
  let forward;
  try{product.details={...saved,answers:{...previous,...patch}};forward=evaluator.evaluate(observation.amber,product);}
  finally{product.details=saved;}
  if(forward.failed||forward.issueFields?.some(k=>[processing.target,size?.target,'sourceSupport'].includes(k))
    ||forward.base?.[processing.target]!==mappings[0].evaluatedOutput
    ||info&&forward.base?.[size.target]!==patch.size)fail('FORWARD_UNPROVEN');
  const full=(await lifecycle.readFullProductStates(client,[product.id],{lock}))[0];
  const evidence=JSON.parse(JSON.stringify({version:1,proofKind:'administrator_attested_historical_characteristic',actorUserId:options.actorUserId,
    attestation:input.attestation,reason:input.reason,
    productId:product.id,sku:product.full_sku,publicIdentityId:String(product.public_product_identity_id),bootstrap:origin,encoding,
    amberHash:state.amberHash,bindingHash:state.bindingHash,currentHash:configuration.config_hash,
    remoteHash:c.hash({raw:observation.raw,domainEvidence:observation.domainEvidence,schema:observation.schema}),
    firstEvidenceHash:first.evidenceHash,full,patch,mapping:mappings[0],frozenOption:frozenOptions[0],currentOption:rawOptions[0],beforeNames:pair(before),
    changes:Object.entries(patch).map(([key,after])=>({key,before:{known:true,present:false,wasAbsent:!Object.hasOwn(previous,key),
      ...(Object.hasOwn(previous,key)?{value:previous[key]}:{})},after}))}));
  return {first,projection,patch,processingLabel:candidates[0].label,remoteOptionId:mappings[0].optionId,evidence,
    previewToken:c.hash({input:selection(input),evidence})};
}
function response(state,prepared){return {sku:state.publicSku,productId:state.productId,previewToken:prepared.previewToken,
  proofKind:prepared.evidence.proofKind,changes:prepared.evidence.changes,
  processing:{valueId:prepared.patch.stone_processing,label:prepared.processingLabel,remoteOptionId:prepared.remoteOptionId},
  historyMode:prepared.first.mode,blockers:prepared.first.blockers,readyForOutbound:false,remoteWrites:0,syncJobEnqueued:false};}
async function review(config,input,options={}){
  command(input);options=optionsFor(options);const boundary=require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config,input,options,async state=>{
    const auth=await options.databasePool.connect();try{await administrator(auth,options);}finally{auth.release();}
    const {observation}=await boundary.observe(config,{sku:state.publicSku,bindingRevisionId:input.bindingRevisionId},options);
    const client=await options.databasePool.connect();
    try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const prepared=await prepareOnClient(client,{config,observation,state,input,options});await client.query('COMMIT');return response(state,prepared);
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  });
}
async function apply(config,input,options={}){
  command(input,true);options=optionsFor(options);const boundary=require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config,input,options,async state=>{
    const auth=await options.databasePool.connect();try{await administrator(auth,options);}finally{auth.release();}
    const actionHash=c.hash({actorUserId:options.actorUserId,input:selection(input),previewToken:input.previewToken});
    const prior=(await options.databasePool.query('SELECT details FROM audit_events WHERE event_key=$1 AND subject_type=$2 AND subject_id=$3 ORDER BY id LIMIT 2',[EVENT,'legacy_input_completion',actionHash])).rows;
    if(prior.length){if(prior.length!==1||prior[0].details?.result?.productId!==state.productId
      ||prior[0].details.result.sku!==state.publicSku)fail('RECEIPT_CONFLICT');return {...prior[0].details.result,alreadyApplied:true};}
    const {observation}=await boundary.observe(config,{sku:state.publicSku,bindingRevisionId:input.bindingRevisionId},options);
    const client=await options.databasePool.connect();
    try{
      await client.query('BEGIN');await require('./sync-job-transaction').revalidate(client,config,state,options);
      const prepared=await prepareOnClient(client,{config,observation,state,input,options,lock:true});
      if(prepared.previewToken!==input.previewToken)fail('PREVIEW_STALE');
      if(prepared.first.historyAdmission)await historyAdmission.assertOnClient(client,config,observation,prepared.first.historyAdmission);
      const product=observation.amber.product;
      const update=await client.query("UPDATE products SET details=jsonb_set(COALESCE(details,'{}'::jsonb),'{answers}',$2::jsonb,TRUE) WHERE id=$1",
        [product.id,JSON.stringify({...product.details.answers,...prepared.patch})]);
      if(update.rowCount!==1)fail('SOURCE_CHANGED');
      const names=await require('./first-sync-local-apply').applyFirstSyncLocal(client,{config,observation,
        projection:prepared.projection,acceptedFields:[],actorUserId:options.actorUserId,reanchorAfterPrice:true});
      const post=await previews.readPreviewProductOnClient(client,{productId:product.id,bindingRevisionId:input.bindingRevisionId});
      if(c.hash(pair(evaluator.evaluate(post,post.product)))!==c.hash(prepared.evidence.beforeNames))fail('NAME_REVIEW_REQUIRED');
      const fullRevision=names.fullRevision || (await lifecycle.advanceFullProductRevision(client,product.id,prepared.evidence.full.revision)).revision;
      let progress=null;
      if(prepared.first.mode==='first'){
        const projected=projectFirstSyncFields({observation:{amber:post,raw:observation.raw,
          schema:observation.schema,domainEvidence:observation.domainEvidence},receipts:(prepared.first.progress?.fields || [])
          .filter(f=>TERMINAL.has(f.state)).map(({target,scope,state})=>({target,scope,state}))});
        if(!projected.plan)fail('POST_STATE_UNPROVEN');
        const plan=prepareProgress(projected,prepared.first.progress);
        const fields=plan.rows.map(row=>row.received?row.record:{...row.record,state:'review_required',after:row.local.value ?? null,
          source:{...row.record.source,productId:product.id}});
        const old=prepared.first.progress?.session,root=prepared.first.progress?.historyAdmissionEventId||cutover.rootId(prepared.first.historyAdmission);
        progress=await ledger.recordProgressOnClient(client,{key:prepared.first.key,
          identity:{installationKey:post.revision.installationKey,publicSku:state.publicSku,remoteProductId:String(observation.raw.id),contractVersion:'first-sync-v1',
            initialProductId:old?.initial_product_id||product.id,initialBindingRevisionId:old?.initial_binding_revision_id||input.bindingRevisionId},
          expectedRevision:old?.revision||'0',previewHash:actionHash,fields,actorUserId:options.actorUserId,
          ...(root?{historyAdmissionEventId:root,captureAdmissionState:tx=>cutover.captureState(tx,product.id)}:{}),
          requiredScopes:plan.manifest,complete:false,readyForOutbound:false});
      }
      const request=(await client.query('SELECT desired_generation::text,state FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[state.publicIdentityId])).rows[0] || null;
      const result={sku:state.publicSku,productId:product.id,fullRevision,changes:response(state,prepared).changes,
        historyMode:prepared.first.mode,blockers:prepared.first.blockers,progress,automaticRequest:request,
        readyForOutbound:false,remoteWrites:0,syncJobEnqueued:false,alreadyApplied:false};
      await writeAuditEvent(client,{mutationContext:{actorUserId:options.actorUserId},eventKey:EVENT,
        subjectType:'legacy_input_completion',subjectId:actionHash,details:{input:selection(input),evidence:prepared.evidence,result}});
      await gate.commit(client);return result;
    }catch(e){await gate.rollback(client).catch(()=>{});throw e;}finally{await gate.release(client).catch(()=>{});client.release();}
  });
}
module.exports={review,apply,command,prepareOnClient};
