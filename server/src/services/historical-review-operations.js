const { randomUUID } = require('node:crypto');
const c = require('./magento/binding-contract');
const s = require('./historical-reactivation-state');
const service = require('./historical-standard-reactivation.service');
const { runAccessAdminMutation } = require('./access-admin-transaction');
const FORMAT = 'historical-review-operation-v1';
const CONFIRM_FIELDS = ['skus','selectedSkus','selectedCreateSkus','reviewNonce','reviewHash','reviewToken',
  'reviewExpiresAt','idempotencyKey','confirmCurrentFactsAndStandardDelivery'];
async function present(db) { return !!(await db.query("SELECT to_regclass('historical_review_operations') name")).rows[0]?.name; }
async function available(db) { if (!await present(db)) s.fail('HISTORICAL_REVIEW_MIGRATION_REQUIRED'); }
function envelope(row) {
  return { format:FORMAT,operationId:row.id,kind:row.kind,state:row.state,skus:row.request.skus,
    createdAt:row.created_at,deadlineAt:row.deadline_at,completedAt:row.completed_at,
    selectedSkus:row.kind==='confirm'?row.request.selectedSkus:null,
    progress:row.progress,result:row.result,failureCode:row.failure_code,failureStatus:row.failure_status };
}
async function find(db,id) { return (await db.query('SELECT * FROM historical_review_operations WHERE id=$1',[id])).rows[0]; }
async function read(id,options={}) {
  c.identity(id);const {db,actor}=service.dependencies(options);
  await s.authority(db,actor,true);await available(db);
  const row=await find(db,id);
  if (!row || Number(row.actor_user_id)!==actor) s.fail('HISTORICAL_OPERATION_NOT_FOUND',404);
  return envelope(row);
}
function request(kind,input) {
  if (kind==='preview') { c.command(input,['skus','operationId']);c.identity(input.operationId);return {skus:s.normalizeSkus(input.skus)}; }
  if (kind!=='confirm') c.invalid();
  const legacy=input.confirmCurrentFactsAndHiddenUpdate===true;
  c.command(input,legacy?CONFIRM_FIELDS.filter(k=>!['selectedCreateSkus','confirmCurrentFactsAndStandardDelivery'].includes(k)).concat('confirmCurrentFactsAndHiddenUpdate'):CONFIRM_FIELDS);
  c.identity(input.idempotencyKey);c.identity(input.reviewNonce);
  s.normalizeSkus(input.skus);s.normalizeSkus(input.selectedSkus);
  if (!legacy && (!Array.isArray(input.selectedCreateSkus) || input.selectedCreateSkus.length>input.selectedSkus.length
    || input.selectedCreateSkus.some(x=>!input.selectedSkus.includes(x))
    || new Set(input.selectedCreateSkus).size!==input.selectedCreateSkus.length || input.confirmCurrentFactsAndStandardDelivery!==true)
    || new Set(input.selectedSkus).size!==input.selectedSkus.length || !/^[a-f0-9]{64}$/.test(input.reviewHash || '')
    || !/^[a-f0-9]{64}$/.test(input.reviewToken || '') || !Number.isFinite(Date.parse(input.reviewExpiresAt)))
    s.fail('HISTORICAL_CONFIRMATION_REQUIRED',422);
  if (JSON.stringify(input).length>65536) c.invalid();
  return JSON.parse(JSON.stringify(input));
}
async function start(kind,input,options={}) {
  const payload=request(kind,input),id=kind==='preview'?input.operationId:input.idempotencyKey;
  const {db,actor,now}=service.dependencies(options);await available(db);
  return runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'export_templates.publish',createError:c.error,
    operation:async client=>{
      await s.authority(client,actor);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`historical_review_actor:${actor}`]);
      const original=await find(client,id),hash=c.hash(payload);
      if(original) {
        if(Number(original.actor_user_id)!==actor || original.kind!==kind || original.request_hash!==hash) s.fail('HISTORICAL_IDEMPOTENCY_CONFLICT');
        return envelope(original);
      }
      const pending=(await client.query("SELECT id FROM historical_review_operations WHERE actor_user_id=$1 AND kind=$2 AND state IN ('queued','running')",[actor,kind])).rows[0];
      if(pending) throw c.error(409,'HISTORICAL_OPERATION_ACTIVE','Read the existing historical operation',{operationId:pending.id});
      const deadline=Math.min(now()+s.TTL,kind==='confirm'?Date.parse(payload.reviewExpiresAt):Infinity);
      const row=(await client.query(`INSERT INTO historical_review_operations(id,actor_user_id,kind,request,request_hash,deadline_at,progress)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,actor,kind,JSON.stringify(payload),hash,new Date(deadline),
        JSON.stringify({phase:'queued',completed:0,total:payload.skus.length})])).rows[0];
      return envelope(row);
    }});
}
async function run(id,options={}) {
  const {db,config}=service.dependencies(options),session=await db.connect(),key=`historical_review_operation:${id}`;
  let locked=false,row,token;const controller=new AbortController();
  const disconnected=()=>controller.abort();session.on('error',disconnected);
  const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
  const check=()=>{if(signal.aborted)s.fail('HISTORICAL_OPERATION_INTERRUPTED');};
  try {
    locked=(await session.query('SELECT pg_try_advisory_lock(hashtext($1)) held',[key])).rows[0].held;
    if(!locked)return;
    row=await find(session,id);if(!row || !['queued','running'].includes(row.state))return row && envelope(row);
    token=randomUUID();
    row=(await session.query(`UPDATE historical_review_operations SET state='running',run_token=$2,started_at=CURRENT_TIMESTAMP,
      progress=$3 WHERE id=$1 AND state IN ('queued','running') RETURNING *`,[id,token,JSON.stringify({phase:'starting',completed:0,total:row.request.skus.length})])).rows[0];
    const actor=Number(row.actor_user_id);
    const update=async(client,state,result,failure)=>{
      check();
      const changed=await client.query(`UPDATE historical_review_operations SET state=$3,result=$4,failure_code=$5,failure_status=$6,
        completed_at=CURRENT_TIMESTAMP,progress=$7 WHERE id=$1 AND state='running' AND run_token=$2 RETURNING id`,
      [id,token,state,result?JSON.stringify(result):null,failure?.code || null,failure?.status || null,
        JSON.stringify({phase:state,completed:state==='ready'?row.request.skus.length:row.progress.completed,total:row.request.skus.length})]);
      if(!changed.rowCount)s.fail('HISTORICAL_OPERATION_INTERRUPTED');
    };
    const onProgress=async progress=>{
      check();await s.authority(session,actor,true);
      const changed=await session.query("UPDATE historical_review_operations SET progress=$3 WHERE id=$1 AND state='running' AND run_token=$2 RETURNING id",[id,token,JSON.stringify(progress)]);
      if(!changed.rowCount)s.fail('HISTORICAL_OPERATION_INTERRUPTED');row.progress=progress;
    };
    const workerOptions={...options,databasePool:db,config,actorUserId:actor,signal,deadlineAt:new Date(row.deadline_at).getTime(),onProgress,
      mutationContext:{actorUserId:actor,requestId:`historical-review-${id}`},onConfirmed:async(client,result)=>{
        if(Date.now()>=new Date(row.deadline_at).getTime())s.fail('HISTORICAL_OPERATION_DEADLINE');
        await update(client,'ready',result);
      }};
    await s.authority(session,actor,true);check();
    // Existing immutable confirmation receipts remain recoverable even after
    // expiry. A new confirmation still revalidates every selected identity.
    const result=row.kind==='preview'?await service.preview(row.request,workerOptions):await service.confirm(row.request,workerOptions);
    check();
    if(row.kind==='preview' && Date.now()>=new Date(row.deadline_at).getTime())s.fail('HISTORICAL_OPERATION_DEADLINE');
    const current=await find(session,id);
    if(current.state!=='ready') {await s.authority(session,actor,true);await update(session,'ready',result);}
    return envelope(await find(session,id));
  } catch(cause) {
    if(!row || !token)throw cause;
    // If COMMIT/connection status is unknown leave running for recovery. The
    // confirm result and intents commit together; never label accepted work failed.
    const current=await find(session,id);
    if(current.state==='ready')return envelope(current);
    if(signal.aborted)return envelope(current);
    const code=/^(HISTORICAL|MAGENTO|ADMIN|AUTH|ACCESS|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '')?cause.code:'HISTORICAL_OPERATION_FAILED';
    const status=Number.isInteger(cause.statusCode)&&cause.statusCode>=400&&cause.statusCode<=599?cause.statusCode:409;
    if(cause.code && !/^(HISTORICAL|MAGENTO|ADMIN|AUTH|ACCESS|LIFECYCLE)_/.test(cause.code))throw cause;
    await session.query(`UPDATE historical_review_operations SET state='failed',failure_code=$3,failure_status=$4,
      completed_at=CURRENT_TIMESTAMP,progress=progress||'{"phase":"failed"}'::jsonb WHERE id=$1 AND state='running' AND run_token=$2`,[id,token,code,status]);
    return envelope(await find(session,id));
  } finally {
    controller.abort();session.removeListener('error',disconnected);
    if(locked)await session.query('SELECT pg_advisory_unlock(hashtext($1))',[key]).catch(()=>{});
    session.release();
  }
}
async function processPending(config,options) {
  if(options.stopping?.() || !await present(options.databasePool))return;
  const rows=(await options.databasePool.query("SELECT id FROM historical_review_operations WHERE state IN ('queued','running') ORDER BY created_at,id LIMIT 2")).rows;
  for(const row of rows){if(options.stopping?.())break;await run(row.id,{...options,config});}
}
module.exports={FORMAT,start,read,run,processPending,request,envelope};
