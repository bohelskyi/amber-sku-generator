const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const service = require('../historical-standard-reactivation.service');
const boundary = require('./historical-standard-boundary');
const lifecycle = require('../product-lifecycle-state');
const jobs = require('./sync-job.service');
const recovery = require('./sync-job-recovery');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');
async function readIntent(db,id) {c.identity(id);return (await db.query('SELECT * FROM historical_standard_intents WHERE id=$1',[id])).rows[0];}
async function complete(config,id,options) {
  const db=options.databasePool,initial=await readIntent(db,id);
  if(!initial || initial.state==='completed')return initial;
  if(!initial.native_job_id)return initial;
  const job=(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[initial.native_job_id])).rows[0];
  if(job?.state!=='succeeded' || !job.acknowledged_at)return initial;
  return runAccessAdminMutation({databasePool:db,actorUserId:Number(initial.actor_user_id),requiredPermission:'export_templates.publish',createError:c.error,
    operation:async client=>{
      await s.authority(client,Number(initial.actor_user_id));
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${initial.installation_key}`]);
      const binding=await s.currentBinding(client,config);
      const product=await lifecycle.readTarget(client,Number(initial.product_id),{origin:initial.origin_hash,lock:true});
      const intent=(await client.query('SELECT * FROM historical_standard_intents WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(intent.state==='completed')return intent;
      if(binding.row.id!==intent.binding_revision_id || binding.fingerprint!==intent.binding_hash)s.fail('HISTORICAL_BINDING_CHANGED');
      if(s.fingerprint(product.product,product.lifecycle)!==intent.local_fingerprint)s.fail('HISTORICAL_CURRENT_FACTS_CHANGED');
      const confirmed=(await client.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[intent.native_job_id])).rows[0];
      if(confirmed.state!=='succeeded' || !confirmed.acknowledged_at || confirmed.plan_hash!==intent.plan_hash
        || confirmed.product_id!==intent.product_id || String(confirmed.public_product_identity_id)!==String(intent.public_product_identity_id)
        || confirmed.intent.mode!==intent.delivery_mode || confirmed.sku!==intent.public_sku || !confirmed.remote_product_id
        || intent.remote_product_id && String(confirmed.remote_product_id)!==String(intent.remote_product_id))s.fail('HISTORICAL_ORIGINAL_JOB_REQUIRED');
      await client.query("SELECT set_config('amber.historical_standard_apply',$1,true)",[id]);
      await client.query("UPDATE products SET status='active',exclude_from_export=0,archived_by_user_id=NULL WHERE id=$1",[intent.product_id]);
      await client.query(`UPDATE product_full_export_state SET route='normal',hold_reason=NULL,business_exclusion_state='none',
        evidence=evidence||jsonb_build_object('historicalStandardReactivationIntent',$2::text),delivery_version=delivery_version+1,
        updated_at=CURRENT_TIMESTAMP WHERE product_id=$1`,[intent.product_id,id]);
      const result=(await client.query(`UPDATE historical_standard_intents SET state='completed',reason_code=NULL,
        confirmed_remote_product_id=(SELECT remote_product_id FROM magento_sync_jobs WHERE id=$2),
        delivery_verified_at=(SELECT acknowledged_at FROM magento_sync_jobs WHERE id=$2),local_activated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`,[id,intent.native_job_id])).rows[0];
      await writeAuditEvent(client,{mutationContext:{actorUserId:Number(intent.actor_user_id),requestId:`historical-standard-complete-${id}`},
        eventKey:'product.historical_standard_completed',subjectType:'product',subjectId:intent.product_id,
        details:{intentId:id,jobId:intent.native_job_id,deliveryMode:intent.delivery_mode,remoteProductId:String(confirmed.remote_product_id),
          targetStatus:intent.target_status,targetVisibility:intent.target_visibility,priorFacts:'unknown'}});
      return result;
    }});
}
async function record(db,intent,state,reason,options={}) {
  const client=await db.connect();
  try{await client.query('BEGIN');
    const updated=(await client.query("UPDATE historical_standard_intents SET state=$2,reason_code=$3 WHERE id=$1 AND state<>'completed' RETURNING *",[intent.id,state,reason])).rows[0];
    if(updated)await writeAuditEvent(client,{mutationContext:{actorUserId:Number(intent.actor_user_id),requestId:`historical-standard-state-${intent.id}`},
      eventKey:'product.historical_standard_delivery_state',subjectType:'product',subjectId:intent.product_id,
      details:{intentId:intent.id,state,reasonCode:reason,nativeJobId:updated.native_job_id}});
    await client.query('COMMIT');return updated;
  }catch(cause){await client.query('ROLLBACK').catch(()=>{});options.logger?.warn?.('historical.standard.state_failed',{code:cause.code});throw cause;}
  finally{client.release();}
}
async function runIntent(config,id,options) {
  const db=options.databasePool,intent=await readIntent(db,id);
  if(!intent || !['queued','delivering'].includes(intent.state))return intent;
  const actor=Number(intent.actor_user_id),jobOptions={...options,actorUserId:actor,
    mutationContext:{actorUserId:actor,requestId:`historical-standard-worker-${id}`}};
  try{
    await s.authority(db,actor,true);
    let job=intent.native_job_id?(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[intent.native_job_id])).rows[0]:null;
    if(!job){
      job=await jobs.enqueue(config,{sku:intent.public_sku,bindingRevisionId:intent.binding_revision_id},jobOptions);
      await runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'export_templates.publish',createError:c.error,
        operation:async client=>{await s.authority(client,actor);await client.query("UPDATE historical_standard_intents SET state='delivering',native_job_id=$2,reason_code=NULL WHERE id=$1 AND state='queued'",[id,job.id]);
          await writeAuditEvent(client,{mutationContext:jobOptions.mutationContext,eventKey:'product.historical_standard_job_attached',subjectType:'product',subjectId:intent.product_id,details:{intentId:id,jobId:job.id}});}});
    }
    const dispatched=(await db.query("SELECT 1 FROM magento_sync_steps WHERE job_id=$1 AND state='dispatched'",[job.id])).rowCount;
    if(job.state==='succeeded')return complete(config,id,options);
    if(job.state==='uncertain' || dispatched){
      // A restart only GET-inspects sticky evidence; it never calls APPLY here.
      const inspection=await recovery.inspect(config,job.id,jobOptions);
      if(inspection.canReconcile){
        await recovery.reconcile(config,job.id,{review:inspection.review,reviewHash:inspection.reviewHash,
          reason:'Historical standard intent: record exact fresh GET receipt'},jobOptions);
        return complete(config,id,options);
      }
      return record(db,intent,'delivering','HISTORICAL_DELIVERY_RECONCILIATION_REQUIRED',options);
    }
    if(job.state==='blocked')return record(db,intent,'blocked',job.failure?.code || 'HISTORICAL_STANDARD_REVIEW_REQUIRED',options);
    job=await jobs.applyJob(config,job.id,{...jobOptions,apply:true});
    if(job.state==='succeeded')return complete(config,id,options);
    return record(db,intent,job.state==='blocked'?'blocked':'delivering',job.failure?.code || 'HISTORICAL_DELIVERY_PENDING',options);
  }catch(cause){
    const current=await readIntent(db,id);
    if(current.state==='completed')return current;
    const sticky=current.native_job_id && (await db.query('SELECT 1 FROM magento_sync_steps WHERE job_id=$1 LIMIT 1',[current.native_job_id])).rowCount;
    const code=/^(HISTORICAL|MAGENTO|ADMIN|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '')?cause.code:'HISTORICAL_STANDARD_REVIEW_REQUIRED';
    return record(db,current,sticky?'delivering':'blocked',code,options);
  }
}
async function inspect(config,id,options) {
  const {db,actor}=service.dependencies(options);await s.authority(db,actor,true);
  const intent=await readIntent(db,id);
  if(!intent)return require('./historical-reactivation-worker').inspect(config,id,options);
  const job=intent.native_job_id?(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[intent.native_job_id])).rows[0]
    :(await db.query(`SELECT * FROM magento_sync_jobs WHERE public_product_identity_id=$1 AND origin_hash=$2 AND state<>'superseded'
      ORDER BY created_at DESC LIMIT 1`,[intent.public_product_identity_id,intent.origin_hash])).rows[0];
  const hasSteps=job && (await db.query('SELECT 1 FROM magento_sync_steps WHERE job_id=$1 LIMIT 1',[job.id])).rowCount>0;
  const canCancel=!['completed','cancelled'].includes(intent.state) && (!job || ['queued','running','retryable','blocked'].includes(job.state) && !hasSteps);
  const result={...service.receipt(intent),canConfirm:false,canReconcile:false,canContinue:false,canCancel};
  if(!intent.native_job_id || ['blocked','cancelled','completed'].includes(intent.state))return result;
  const checked=await recovery.inspect(config,intent.native_job_id,{...options,databasePool:db,actorUserId:actor});
  return {...result,canReconcile:checked.canReconcile,canContinue:checked.canContinue,
    recoveryReview:checked.review,recoveryReviewHash:checked.reviewHash,remainingCount:checked.remainingCount,blockers:checked.blockers};
}
async function reconcile(config,input,options) {
  c.identity(input.intentId);
  const {db,actor}=service.dependencies(options);await s.authority(db,actor,true);
  const intent=await readIntent(db,input.intentId);
  if(!intent)return require('./historical-reactivation-worker').reconcile(config,input,options);
  c.command(input,['intentId','review','reviewHash','reason']);
  if(intent.state==='completed')return service.receipt(intent);
  if(!intent.native_job_id)s.fail('HISTORICAL_ORIGINAL_JOB_REQUIRED');
  await recovery.reconcile(config,intent.native_job_id,{review:input.review,reviewHash:input.reviewHash,reason:input.reason},
    {...options,databasePool:db,actorUserId:actor});
  return service.receipt(await complete(config,intent.id,{...options,databasePool:db}));
}
async function cancel(input,options={}) {
  c.command(input,['intentId','confirmNoDispatchCancellation']);c.identity(input.intentId);
  if(input.confirmNoDispatchCancellation!==true)s.fail('HISTORICAL_CONFIRMATION_REQUIRED',422);
  const {db,actor}=service.dependencies(options),initial=await readIntent(db,input.intentId);
  if(!initial)s.fail('HISTORICAL_INTENT_NOT_FOUND',404);
  return runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'export_templates.publish',createError:c.error,
    operation:async client=>{
      await s.authority(client,actor);
      for(const key of [`amber_magento_public_identity:${initial.public_product_identity_id}`,`amber_magento_sync:${initial.origin_hash}:${initial.public_sku}`])
        if(!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held',[key])).rows[0].held)s.fail('HISTORICAL_BUSY');
      await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[initial.product_id]);
      const intent=(await client.query('SELECT * FROM historical_standard_intents WHERE id=$1 FOR UPDATE',[initial.id])).rows[0];
      if(intent.state==='cancelled')return service.receipt(intent);
      if(intent.state==='completed')s.fail('HISTORICAL_DELIVERY_ALREADY_CONFIRMED');
      const job=intent.native_job_id?(await client.query('SELECT * FROM magento_sync_jobs WHERE id=$1 FOR UPDATE',[intent.native_job_id])).rows[0]
        :(await client.query(`SELECT * FROM magento_sync_jobs WHERE public_product_identity_id=$1 AND origin_hash=$2 AND state<>'superseded'
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[intent.public_product_identity_id,intent.origin_hash])).rows[0];
      if(job && (job.plan_hash!==intent.plan_hash || job.created_by_user_id!==intent.actor_user_id || job.product_id!==intent.product_id))s.fail('HISTORICAL_ORIGINAL_JOB_REQUIRED');
      if(job && (!['queued','running','retryable','blocked'].includes(job.state)
        || (await client.query('SELECT 1 FROM magento_sync_steps WHERE job_id=$1 LIMIT 1',[job.id])).rowCount))s.fail('HISTORICAL_DELIVERY_RECONCILIATION_REQUIRED');
      await client.query("SELECT set_config('amber.historical_standard_cancel',$1,true)",[intent.id]);
      const result=(await client.query("UPDATE historical_standard_intents SET state='cancelled',native_job_id=$2,reason_code='HISTORICAL_CANCELLED_BEFORE_DISPATCH',cancelled_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[intent.id,job?.id || null])).rows[0];
      if(job)await client.query("UPDATE magento_sync_jobs SET state='superseded',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[job.id]);
      await writeAuditEvent(client,{mutationContext:options.mutationContext || {actorUserId:actor,requestId:`historical-standard-cancel-${intent.id}`},
        eventKey:'product.historical_standard_cancelled',subjectType:'product',subjectId:intent.product_id,
        details:{intentId:intent.id,jobId:intent.native_job_id,priorFacts:'unknown',remoteWrites:0,dispatchEvidencePresent:false}});
      return service.receipt(result);
    }});
}
async function processPending(config,options) {
  if(!config.configured || !await boundary.present(options.databasePool))return;
  const rows=(await options.databasePool.query(`SELECT id FROM historical_standard_intents WHERE origin_hash=$1 AND state IN ('queued','delivering')
    ORDER BY last_checked_at NULLS FIRST,created_at,id LIMIT 2`,[c.originHash(config.baseUrl)])).rows;
  for(const row of rows){if(options.stopping?.())break;
    await options.databasePool.query('UPDATE historical_standard_intents SET last_checked_at=CURRENT_TIMESTAMP WHERE id=$1',[row.id]);
    await runIntent(config,row.id,options);
  }
}
module.exports={complete,runIntent,inspect,reconcile,cancel,processPending};
