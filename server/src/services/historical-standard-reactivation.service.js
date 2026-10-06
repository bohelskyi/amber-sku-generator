const { randomUUID } = require('node:crypto');
const c = require('./magento/binding-contract');
const s = require('./historical-reactivation-state');
const lifecycle = require('./product-lifecycle-state');
const standard = require('./magento/historical-standard-boundary');
const { previewProduct } = require('./magento/sync-preview');
const plan = require('./magento/sync-job-plan');
const { runAccessAdminMutation } = require('./access-admin-transaction');
const { writeAuditEvent } = require('../audit/audit-events');
const FORMAT = 'historical-reactivation-standard-v1';
function dependencies(options) {
  const env = (!options.config || !options.reviewSecret) ? require('../config/env') : null;
  return { db:options.databasePool || require('../db/pool'), config:options.config || env.magento,
    secret:options.reviewSecret || env.sessionSecret, actor:Number(options.actorUserId || options.mutationContext?.actorUserId),
    now:options.now || (() => Date.now()) };
}
async function available(db) { if (!await standard.present(db)) s.fail('HISTORICAL_STANDARD_MIGRATION_REQUIRED'); }
async function readTargets(client, skus, origin) {
  const rows = (await client.query(`SELECT p.id,p.full_sku,p.public_product_identity_id,i.public_sku FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE upper(i.public_sku)=ANY($1::text[]) OR upper(p.full_sku)=ANY($1::text[]) ORDER BY p.id`,[skus])).rows;
  const seen = new Set(), items = [];
  for (const inputSku of skus) {
    const direct = rows.filter(p => p.public_sku.toUpperCase()===inputSku);
    const matches = direct.length ? direct : rows.filter(p => p.full_sku?.toUpperCase()===inputSku);
    const item = { inputSku,protocol:standard.PROTOCOL,priorFacts:'unknown',prerequisites:[],blockerCodes:[] };
    if (!matches.length) { items.push({...item,disposition:'blocked',reasonCode:'HISTORICAL_PRODUCT_NOT_FOUND'});continue; }
    if (new Set(matches.map(p => String(p.public_product_identity_id))).size!==1 || !direct.length && matches.length!==1) {
      items.push({...item,disposition:'blocked',reasonCode:'HISTORICAL_PRODUCT_AMBIGUOUS'});continue;
    }
    const row=matches.at(-1);
    if (seen.has(row.id)) {items.push({...item,disposition:'skipped',reasonCode:'HISTORICAL_DUPLICATE_TARGET'});continue;}
    seen.add(row.id);
    const current=await lifecycle.readTarget(client,Number(row.id),{origin});
    const request=(await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[row.public_product_identity_id])).rows[0];
    const legacy=(await client.query('SELECT 1 FROM historical_reactivation_intents WHERE public_product_identity_id=$1',[row.public_product_identity_id])).rowCount;
    const pending=(await client.query("SELECT 1 FROM historical_standard_intents WHERE public_product_identity_id=$1 AND state NOT IN ('completed','cancelled')",[row.public_product_identity_id])).rowCount;
    const reason=s.localIssue(current) || (legacy?'HISTORICAL_ATOMIC_INTENT_EXISTS':pending?'HISTORICAL_INTENT_EXISTS':null);
    items.push({...item,productId:Number(row.id),article:row.public_sku,category:current.product.category,
      currentPriceUah:Number(current.product.total_price_uah),currentWeight:Number(current.product.weight || 0),
      currentRoute:current.lifecycle?.route || null,currentExclusion:Number(current.product.exclude_from_export),
      currentBusinessExclusion:current.lifecycle?.business_exclusion_state || null,
      localFingerprint:s.fingerprint(current.product,current.lifecycle),requestGeneration:request?.desired_generation || null,
      disposition:reason==='HISTORICAL_PRODUCT_ALREADY_ACTIVE'?'skipped':reason?'blocked':'eligible',reasonCode:reason,
      prerequisites:[{code:'LOCAL_ARCHIVED_CURRENT',met:current.product.status==='archived' && current.lifecycle?.route==='retired'},
        {code:'LINEAGE_CLEAR',met:!current.facts.newerRevision && !current.facts.activeSuccessor && !current.facts.correctionHistory
          && current.product.corrected_from_product_id==null && current.product.corrected_to_product_id==null},
        {code:'MEDIA_CLEAR',met:!current.facts.unfinishedMedia},{code:'DELETION_CLEAR',met:!current.facts.testDeletion},
        {code:'SYNC_CLEAR',met:!current.facts.unfinishedJob && !current.facts.unresolvedStep && !current.facts.unresolvedVisibility},
        {code:'CURRENT_PRICE_VALID',met:Number(current.product.total_price_uah)>0}]});
  }
  return items;
}
async function observe(config, db, item, bindingRevisionId, options) {
  let observation;
  const shared = options.batchObservation ? await options.batchObservation.get() : null;
  const report=await (options.previewProduct || previewProduct)(config,{databasePool:db,sku:item.article,bindingRevisionId,
    fetchImpl:options.batchObservation?.fetchImpl || options.fetchImpl,
    discover:shared ? async () => shared.schema : options.discover, categoryObservation:shared?.categories,
    readAmber:standard.readProspective,onObservation:value=>{observation=value;}});
  if (!observation) s.fail('HISTORICAL_OBSERVATION_REQUIRED');
  return { report,observation };
}
async function preview(input, options={}) {
  c.command(input,['skus']);
  const skus=s.normalizeSkus(input.skus),{db,config,secret,actor,now}=dependencies(options);
  await available(db);
  const client=await db.connect();let context,items;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await s.authority(client,actor,true);
    let unavailable=null;
    try {context=await s.currentBinding(client,config);}catch(cause){
      if (!['HISTORICAL_AUTO_DELIVERY_REQUIRED','HISTORICAL_BINDING_REQUIRED'].includes(cause.code)) throw cause;
      unavailable=cause.code;
    }
    items=await readTargets(client,skus,config.configured?c.originHash(config.baseUrl):c.hash('magento-unconfigured'));
    for (const item of items) if(item.productId){
      item.prerequisites.push({code:'AUTOMATIC_DELIVERY_ENABLED',met:unavailable!=='HISTORICAL_AUTO_DELIVERY_REQUIRED'},
        {code:'CURRENT_BINDING_VALID',met:!!context});
      if(item.disposition==='eligible' && unavailable){item.disposition='blocked';item.reasonCode=unavailable;}
    }
    await client.query('COMMIT');
  }catch(cause){await client.query('ROLLBACK').catch(()=>{});throw cause;}finally{client.release();}
  const eligible = items.filter(i=>i.disposition==='eligible');
  const batch = require('./magento/historical-batch-observation').createBatchObservation(config, options);
  let completed = items.length - eligible.length;
  const progress = async phase => options.onProgress?.({ phase, completed, total:items.length });
  try {
  await progress('metadata');
  await batch.map(eligible, async item => {
    batch.check();
    let observed;
    try{observed=await observe(config,db,item,context.row.id,{...options,batchObservation:batch});}catch(cause){
      if(!['MAGENTO_PRODUCT_AMBIGUOUS','MAGENTO_RESPONSE_INVALID'].includes(cause.code))throw cause;
      item.disposition='blocked';item.reasonCode='HISTORICAL_REMOTE_IDENTITY_MISMATCH';return;
    }
    const {observation,report}=observed,raw=observation.raw;
    item.bindingRevisionId=context.row.id;item.bindingHash=context.fingerprint;
    item.deliveryMode=raw?'update':'create';item.requiresExplicitCreate=!raw;
    item.remoteProductId=raw?.id || null;item.observedRemoteStatus=raw?.status ?? null;
    item.observedRemoteVisibility=raw?.visibility ?? null;
    item.targetStatus=raw?.status ?? report.candidatePayload?.product?.status;
    item.targetVisibility=raw?.visibility ?? report.candidatePayload?.product?.visibility;
    item.remoteObservationHash=standard.observationFingerprint(observation);
    item.remoteFingerprint=raw?item.remoteObservationHash:null;
    item.deliveryBlockerCodes=[...new Set(report.blockers.map(b=>b.code))];
    const exact=!raw || raw.sku===item.article && Number.isSafeInteger(raw.id) && raw.id>0;
    const currentName = report.candidatePayload?.product?.name ?? (exact ? raw?.name : null);
    item.currentName = typeof currentName === 'string' && currentName.trim() ? currentName.trim() : null;
    const delivered=report.candidatePayload?.product?.price ?? raw?.price;
    const priceExact=Number.isFinite(Number(delivered)) && Number(delivered)===item.currentPriceUah;
    if(!priceExact)item.deliveryBlockerCodes.push('HISTORICAL_CURRENT_PRICE_NOT_AUTHORITATIVE');
    const reason=!exact?'HISTORICAL_REMOTE_IDENTITY_MISMATCH'
      :![1,2].includes(item.targetStatus) || ![1,2,3,4].includes(item.targetVisibility)?'HISTORICAL_REMOTE_STATUS_UNSUPPORTED'
        :!report.sendable || report.mode!==item.deliveryMode || !priceExact?'HISTORICAL_DELIVERY_PLAN_BLOCKED':null;
    item.prerequisites.push({code:'REVIEWED_REMOTE_OBSERVATION',met:exact},
      {code:'CURRENT_DELIVERY_PLAN_VALID',met:!reason});
    if(!reason)item.deliveryPlanHash=c.hash(plan.intent(report));
    if(reason){item.disposition='blocked';item.reasonCode=reason;}
  }, async () => { completed++; await progress('products'); });
  batch.check();
  await s.authority(db,actor,true);
  batch.check();
  } finally { batch.close(); }
  for(const item of items)item.blockerCodes=item.reasonCode?[item.reasonCode]:[];
  const review={format:FORMAT,protocol:standard.PROTOCOL,reviewNonce:options.reviewNonce || randomUUID(),
    reviewExpiresAt:options.reviewExpiresAt || new Date(now()+s.TTL).toISOString(),originHash:config.configured?c.originHash(config.baseUrl):null,
    installationKey:context?.row.installation_key || null,skus,items};
  return {...review,reviewHash:c.hash(review),reviewToken:s.signReview(actor,review,secret),counts:{
    eligible:items.filter(i=>i.disposition==='eligible').length,blocked:items.filter(i=>i.disposition==='blocked').length,
    skipped:items.filter(i=>i.disposition==='skipped').length}};
}
function receipt(row) {
  return {intentId:row.id,productId:Number(row.product_id),article:row.public_sku,protocol:standard.PROTOCOL,
    state:row.state,reasonCode:row.reason_code || null,deliveryMode:row.delivery_mode,
    targetStatus:row.target_status,targetVisibility:row.target_visibility,remoteProductId:row.remote_product_id?Number(row.remote_product_id):null,
    confirmedRemoteProductId:row.confirmed_remote_product_id?Number(row.confirmed_remote_product_id):null,
    cancelledAt:row.cancelled_at || null,nativeJobId:row.native_job_id || null,deliveryVerifiedAt:row.delivery_verified_at || null,
    localActivatedAt:row.local_activated_at || null,nativeConfirmedAt:row.delivery_verified_at || null,hiddenVerifiedAt:null};
}
async function readBatch(id,options={}) {
  c.identity(id);const {db,actor}=dependencies(options);await s.authority(db,actor,true);await available(db);
  const batch=(await db.query('SELECT * FROM historical_standard_batches WHERE id=$1',[id])).rows[0];
  if(!batch)return require('./historical-reactivation.service').readBatch(id,options);
  return {batchId:id,createdAt:batch.created_at,protocol:standard.PROTOCOL,
    items:(await db.query('SELECT * FROM historical_standard_intents WHERE batch_id=$1 ORDER BY product_id',[id])).rows.map(receipt)};
}
async function confirmLocked(input,options={}) {
  c.command(input,['skus','selectedSkus','selectedCreateSkus','reviewNonce','reviewHash','reviewToken','reviewExpiresAt','idempotencyKey','confirmCurrentFactsAndStandardDelivery']);
  if(input.confirmCurrentFactsAndStandardDelivery!==true || !/^[a-f0-9]{64}$/.test(input.reviewHash || ''))s.fail('HISTORICAL_CONFIRMATION_REQUIRED',422);
  c.identity(input.reviewNonce);c.identity(input.idempotencyKey);
  const skus=s.normalizeSkus(input.skus);s.normalizeSkus(input.selectedSkus);
  if(!Array.isArray(input.selectedCreateSkus))s.fail('HISTORICAL_SELECTION_INVALID',422);
  const selected=[...new Set(input.selectedSkus)],creates=[...new Set(input.selectedCreateSkus)];
  if(selected.length!==input.selectedSkus.length || creates.length!==input.selectedCreateSkus.length
    || ![...selected,...creates].every(x=>typeof x==='string' && x===x.trim()) || creates.some(x=>!selected.includes(x)))s.fail('HISTORICAL_SELECTION_INVALID',422);
  const {db,config,secret,actor,now}=dependencies(options);await available(db);await s.authority(db,actor,true);
  const requestHash=c.hash(input),original=(await db.query('SELECT * FROM historical_standard_batches WHERE id=$1',[input.idempotencyKey])).rows[0];
  if(original){if(Number(original.actor_user_id)!==actor || original.request_hash!==requestHash)s.fail('HISTORICAL_IDEMPOTENCY_CONFLICT');return readBatch(original.id,options);}
  if((await db.query('SELECT 1 FROM historical_reactivation_batches WHERE id=$1',[input.idempotencyKey])).rowCount)s.fail('HISTORICAL_IDEMPOTENCY_CONFLICT');
  const checked=await preview({skus},{...options,reviewNonce:input.reviewNonce,reviewExpiresAt:input.reviewExpiresAt});
  const {reviewHash,reviewToken:ignoredToken,counts:ignoredCounts,...review}=checked;void ignoredToken;void ignoredCounts;
  s.verifyReview(actor,review,input.reviewToken,secret,now());if(reviewHash!==input.reviewHash)s.fail('HISTORICAL_REVIEW_STALE');
  const chosen=review.items.filter(i=>i.disposition==='eligible' && selected.includes(i.article));
  if(chosen.length!==selected.length || chosen.some(i=>(i.deliveryMode==='create')!==creates.includes(i.article)))s.fail('HISTORICAL_SELECTION_INVALID',422);
  await runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'export_templates.publish',createError:c.error,
    operation:async client=>{
      await s.authority(client,actor);await require('./full-product-cutover-gate').requireActive(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${review.installationKey}`]);
      const binding=await s.currentBinding(client,config);if(binding.fingerprint!==chosen[0].bindingHash)s.fail('HISTORICAL_REVIEW_STALE');
      for(const item of [...chosen].sort((a,b)=>a.productId-b.productId)){
        const identity=(await client.query('SELECT public_product_identity_id FROM products WHERE id=$1',[item.productId])).rows[0]?.public_product_identity_id;
        if(!identity)s.fail('HISTORICAL_REVIEW_STALE');
        for(const key of [`amber_magento_public_identity:${identity}`,`amber_magento_sync:${review.originHash}:${item.article}`])
          if(!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held',[key])).rows[0].held)s.fail('HISTORICAL_BUSY');
        await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[item.productId]);
        const current=await lifecycle.readTarget(client,item.productId,{origin:review.originHash,lock:true});
        if(s.localIssue(current) || s.fingerprint(current.product,current.lifecycle)!==item.localFingerprint)s.fail('HISTORICAL_REVIEW_STALE');
        const request=(await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE',[identity])).rows[0];
        if((request?.desired_generation || null)!==item.requestGeneration)s.fail('HISTORICAL_REVIEW_STALE');
        item.identity=String(identity);
      }
      await client.query(`INSERT INTO historical_standard_batches(id,actor_user_id,request_hash,review_hash,selected_skus,selected_create_skus)
        VALUES($1,$2,$3,$4,$5,$6)`,[input.idempotencyKey,actor,requestHash,input.reviewHash,JSON.stringify(selected),JSON.stringify(creates)]);
      for(const item of chosen){
        const id=randomUUID();
        await client.query(`INSERT INTO historical_standard_intents(id,batch_id,actor_user_id,product_id,public_product_identity_id,
          public_sku,origin_hash,installation_key,binding_revision_id,binding_hash,local_fingerprint,request_generation,review,
          delivery_mode,remote_product_id,remote_fingerprint,target_status,target_visibility,plan_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id,input.idempotencyKey,actor,item.productId,item.identity,item.article,review.originHash,review.installationKey,item.bindingRevisionId,
          item.bindingHash,item.localFingerprint,item.requestGeneration,JSON.stringify(item),item.deliveryMode,item.remoteProductId,
          item.remoteFingerprint,item.targetStatus,item.targetVisibility,item.deliveryPlanHash]);
        await writeAuditEvent(client,{mutationContext:options.mutationContext || {actorUserId:actor,requestId:`historical-standard-${id}`},
          eventKey:'product.historical_standard_confirmed',subjectType:'product',subjectId:item.productId,
          details:{intentId:id,batchId:input.idempotencyKey,protocol:standard.PROTOCOL,deliveryMode:item.deliveryMode,priorFacts:'unknown',
            targetStatus:item.targetStatus,targetVisibility:item.targetVisibility,reviewedRemoteProductId:item.remoteProductId,planHash:item.deliveryPlanHash}});
      }
      if(options.onConfirmed) {
        const batchRow=(await client.query('SELECT * FROM historical_standard_batches WHERE id=$1',[input.idempotencyKey])).rows[0];
        const rows=(await client.query('SELECT * FROM historical_standard_intents WHERE batch_id=$1 ORDER BY product_id',[input.idempotencyKey])).rows;
        await options.onConfirmed(client,{batchId:batchRow.id,createdAt:batchRow.created_at,protocol:standard.PROTOCOL,items:rows.map(receipt)});
      }
    }});
  return readBatch(input.idempotencyKey,options);
}
async function confirm(input,options={}) {
  // Recover the old immutable atomic receipt by its original exact request only.
  const {db}=dependencies(options);c.identity(input.idempotencyKey);
  if((await db.query('SELECT 1 FROM historical_reactivation_batches WHERE id=$1',[input.idempotencyKey])).rowCount)
    return require('./historical-reactivation.service').confirm(input,options);
  const session=await db.connect(),key=`historical_reactivation:${input.idempotencyKey}`;
  try{await session.query('SELECT pg_advisory_lock(hashtext($1))',[key]);return await confirmLocked(input,options);}
  finally{await session.query('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(()=>{});session.release();}
}
const cancel=(input,options)=>require('./magento/historical-standard-worker').cancel(input,options);
module.exports={FORMAT,dependencies,preview,confirm,readBatch,receipt,observe,cancel};
