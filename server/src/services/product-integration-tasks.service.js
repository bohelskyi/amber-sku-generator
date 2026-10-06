const { assertAdministrator: assertTestAdministrator } = require('./product/test-products');
const pool = require('../db/pool');
const c = require('./product-integration-task-contract');
const { createMutationContext } = require('../audit/mutation-context');
const { writeAuditEvent } = require('../audit/audit-events');
const { APPLICATION_USER_ADMIN_LOCK_KEY, assertActorStillAuthorized, runAccessAdminMutation } = require('./access-admin-transaction');
const { readCharacteristicConfiguration } = require('./product/characteristic-config');
const { readCreationIntegrationReadiness: readCreationDeliveryReadiness } = require('./product/creation-delivery-readiness');
const { buildNewProductPreview } = require('./product.service');

async function administrator(db,actor) {
  return Boolean((await db.query(`SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id
    JOIN roles r ON r.id=a.role_id JOIN role_permissions p ON p.role_id=r.id AND p.permission_key='export_templates.manage'
    WHERE u.id=$1 AND u.status='active' AND a.revoked_at IS NULL AND r.status='active' AND r.role_key='administrator'`,[actor])).rowCount);
}
async function readTransaction(options,operation) {
  const actor=createMutationContext(options.mutationContext).actorUserId;
  const db=await (options.databasePool || pool).connect();let locked=false;
  try {
    // Acquire authority before the RR snapshot, so waiting behind revocation cannot retain old access.
    await db.query('SELECT pg_advisory_lock_shared(hashtext($1))',[APPLICATION_USER_ADMIN_LOCK_KEY]);locked=true;
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const admin=await administrator(db,actor);
    await assertActorStillAuthorized(db,actor,admin?'export_templates.manage':'products.create',c.error,{readOnly:true});
    const result=await operation(db,{actor,admin});await db.query('COMMIT');return result;
  } catch(error) {await db.query('ROLLBACK');throw error;}
  finally {
    if(locked)await db.query('SELECT pg_advisory_unlock_shared(hashtext($1))',[APPLICATION_USER_ADMIN_LOCK_KEY]);
    db.release();
  }
}
async function taskRow(db,id,access,lock=false) {
  const row=(await db.query(`SELECT t.*,u.display_name FROM product_integration_tasks t
    JOIN application_users u ON u.id=t.actor_user_id WHERE t.id=$1 ${lock?'FOR UPDATE OF t':''}`,[c.identity(id)])).rows[0];
  if(!row)throw c.error(404,'INTEGRATION_TASK_NOT_FOUND','Задачу не знайдено.');
  if(String(row.actor_user_id)!==String(access.actor) && !access.admin)throw c.error(403,'INTEGRATION_TASK_ACCESS_DENIED','Ця задача належить іншому користувачу.');
  return row;
}
async function latestAttempt(db,row) {
  const attempt=(await db.query(`SELECT * FROM product_integration_task_attempts WHERE task_id=$1
    ORDER BY created_at DESC,request_id DESC LIMIT 1`,[row.id])).rows[0];
  if(!attempt)throw c.error(409,'INTEGRATION_TASK_CONTEXT_UNAVAILABLE','Контекст задачі не підтверджено.');
  return attempt;
}
async function photoMetadata(db,product,actor,lock=false) {
  const ids=product.photoIds || [];
  if(!ids.length)return {photos:[],unavailablePhotoIds:[],canResume:true};
  const rows=(await db.query(`SELECT id,display_name,mime_type,content_hash,expires_at,
    (product_id IS NULL AND expires_at>CURRENT_TIMESTAMP) AS usable FROM product_photo_assets
    WHERE id=ANY($1::uuid[]) AND actor_user_id=$2 ${lock?'FOR SHARE':''}`,[ids,actor])).rows;
  const ordered=ids.map(id=>rows.find(row=>row.id===id));
  const unavailablePhotoIds=ids.filter((id,index)=>!ordered[index]?.usable);
  return {photos:ordered.filter(Boolean).map(row=>({id:row.id,name:row.display_name,mimeType:row.mime_type,hash:row.content_hash,
    expiresAt:row.expires_at,available:row.usable})),unavailablePhotoIds,canResume:unavailablePhotoIds.length===0};
}
async function present(db,row,access,detail=false) {
  const owner=String(row.actor_user_id)===String(access.actor);
  const result={id:row.id,revision:String(row.revision),state:row.state,categoryCode:row.category_code,categoryLabel:row.category_label,
    questionKey:row.defect.questionKey,questionLabel:row.question_label,valueId:row.defect.valueId,valueLabel:row.value_label,
    reasonCode:row.defect.reasonCode,message:row.defect.message,createdAt:row.created_at,
    createdBy:{id:Number(row.actor_user_id),displayName:row.display_name || 'Користувач'},...c.links(row,owner),
    productCreationAllowedLocally:true,deliveryAccepted:false};
  if(detail) {
    const attempt=await latestAttempt(db,row);const product=c.productPayload(attempt.creation_payload);
    result.creationContext=owner?{product,photoCount:(product.photoIds || []).length,...await photoMetadata(db,product,access.actor)}
      :{inputs:Object.fromEntries(Object.entries(product).filter(([key])=>!['photoIds','enableWhenPhotosVerified'].includes(key))),photoCount:(product.photoIds || []).length};
  }
  return result;
}
async function read(id,options={}) {return readTransaction(options,async(db,access)=>present(db,await taskRow(db,id,access),access,true));}
async function list(input={},options={}) {
  c.object(input,['state','offset','limit']);
  const state=input.state ?? 'open';const offset=Number(input.offset ?? 0);const limit=Number(input.limit ?? 20);
  if(!['open','resolved','cancelled'].includes(state) || !Number.isSafeInteger(offset) || offset<0 || offset>10000
    || !Number.isSafeInteger(limit) || limit<1 || limit>100)c.invalid();
  return readTransaction(options,async(db,access)=>{
    const rows=(await db.query(`SELECT t.*,u.display_name FROM product_integration_tasks t JOIN application_users u ON u.id=t.actor_user_id
      WHERE t.state=$1 AND ($2::boolean OR t.actor_user_id=$3) ORDER BY t.created_at DESC,t.id DESC OFFSET $4 LIMIT $5`,
    [state,access.admin,access.actor,offset,limit+1])).rows;
    return {items:await Promise.all(rows.slice(0,limit).map(row=>present(db,row,access))),nextOffset:rows.length>limit?offset+limit:null};
  });
}
async function recover(requestId,options={}) {
  return readTransaction(options,async(db,access)=>{
    const row=(await db.query('SELECT task_id FROM product_integration_task_attempts WHERE actor_user_id=$1 AND request_id=$2',
      [access.actor,c.identity(requestId)])).rows[0];
    if(!row)throw c.error(404,'INTEGRATION_TASK_ATTEMPT_NOT_FOUND','Результат спроби ще не знайдено. Не надсилайте її повторно.');
    return present(db,await taskRow(db,row.task_id,access),access,true);
  });
}
async function create(input,options={}) {
  const command=c.creationCommand(input);const context=createMutationContext(options.mutationContext);
  const databasePool=options.databasePool || pool;
  await readTransaction(options,async(db)=>{
    await assertActorStillAuthorized(db,context.actorUserId,'products.create',c.error,{readOnly:true});
    if(command.product.isTestProduct===true)await assertTestAdministrator(db,context.actorUserId,{readOnly:true});
  });
  // Check a completed UUID before rebuilding: changed prices/config do not erase the original receipt.
  const previous=(await databasePool.query('SELECT task_id,request_hash FROM product_integration_task_attempts WHERE actor_user_id=$1 AND request_id=$2',
    [context.actorUserId,command.clientRequestId])).rows[0];
  if(previous) {
    if(previous.request_hash!==command.requestHash)throw c.error(409,'INTEGRATION_TASK_IDEMPOTENCY_CONFLICT','Ця спроба вже містить інші дані.');
    return read(previous.task_id,options);
  }
  const preview=await (options.buildPreview || buildNewProductPreview)(command.product,{queryable:databasePool,mutationContext:context,
    ...(options.config?{creationDeliveryConfig:options.config}:{})});
  if(preview.previewToken!==command.expectedPreviewToken || preview.mode!=='public_identity')
    throw c.error(409,'INTEGRATION_TASK_PREVIEW_STALE','Повторіть перевірку поточних даних товару.');
  const defect=c.defectOf(preview.creationDeliveryReadiness);const defectHash=c.fingerprint(defect);
  const product={...command.product,answers:preview.normalizedAnswers,weight:preview.weightVal};
  return runAccessAdminMutation({databasePool,actorUserId:context.actorUserId,requiredPermission:'products.create',createError:c.error,
    operation:async db=>{
      if(product.isTestProduct===true)await assertTestAdministrator(db,context.actorUserId);
      const access={actor:context.actorUserId,admin:await administrator(db,context.actorUserId)};
      const prior=(await db.query('SELECT task_id,request_hash FROM product_integration_task_attempts WHERE actor_user_id=$1 AND request_id=$2',
        [context.actorUserId,command.clientRequestId])).rows[0];
      if(prior) {
        if(prior.request_hash!==command.requestHash)throw c.error(409,'INTEGRATION_TASK_IDEMPOTENCY_CONFLICT');
        return present(db,await taskRow(db,prior.task_id,access),access,true);
      }
      await db.query('SELECT id FROM questions WHERE category_code=$1 FOR SHARE',[product.categoryCode]);
      await db.query('SELECT o.id FROM options o JOIN questions q ON q.id=o.question_id WHERE q.category_code=$1 FOR SHARE OF o',[product.categoryCode]);
      const configuration=await readCharacteristicConfiguration(db,product.categoryCode);
      if(configuration.config_hash!==preview.characteristicConfigHash)throw c.error(409,'INTEGRATION_TASK_PREVIEW_STALE');
      const readiness=await readCreationDeliveryReadiness(db,product.categoryCode,preview,options.config?{config:options.config}:{});
      if(c.hash(readiness)!==c.hash(preview.creationDeliveryReadiness))throw c.error(409,'INTEGRATION_TASK_PREVIEW_STALE');
      const photos=await photoMetadata(db,product,context.actorUserId,true);
      if(!photos.canResume)throw c.error(409,'INTEGRATION_TASK_PHOTOS_UNAVAILABLE','Фото вже прикріплені до товару або строк збереження минув.');
      let row=(await db.query(`SELECT t.*,u.display_name FROM product_integration_tasks t JOIN application_users u ON u.id=t.actor_user_id
        WHERE t.actor_user_id=$1 AND t.defect_hash=$2 AND t.state='open' FOR UPDATE OF t`,[context.actorUserId,defectHash])).rows[0];
      if(!row) {
        const count=(await db.query("SELECT count(*)::int AS count FROM product_integration_tasks WHERE actor_user_id=$1 AND state='open'",[context.actorUserId])).rows[0].count;
        if(count>=20)throw c.error(409,'INTEGRATION_TASK_OPEN_LIMIT','Спочатку опрацюйте попередні інтеграційні задачі.');
        const category=(await db.query('SELECT name FROM categories WHERE code=$1',[product.categoryCode])).rows[0];
        const question=configuration.questions.find(q=>q.key===defect.questionKey);
        const value=question?.options.find(o=>String(o.value_id)===String(defect.valueId));
        const id=c.randomUUID();
        await db.query(`INSERT INTO product_integration_tasks(id,actor_user_id,defect_hash,defect,category_code,category_label,question_label,value_label)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,[id,context.actorUserId,defectHash,JSON.stringify(defect),product.categoryCode,
          category?.name || product.categoryCode,question?.label ?? null,value?.label ?? null]);
        row=await taskRow(db,id,access);
        await writeAuditEvent(db,{mutationContext:context,eventKey:'product.integration_task_created',subjectType:'product_integration_task',subjectId:id,
          details:{categoryCode:product.categoryCode,reasonCode:defect.reasonCode}});
      }
      await db.query(`INSERT INTO product_integration_task_attempts(actor_user_id,request_id,request_hash,task_id,creation_payload,configuration_hash,preview_hash)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,[context.actorUserId,command.clientRequestId,command.requestHash,row.id,
        JSON.stringify(product),configuration.config_hash,command.expectedPreviewToken]);
      return present(db,row,access,true);
    }});
}
async function inspectResolution(db,row,actor,options) {
  const attempt=await latestAttempt(db,row);const product=c.productPayload(attempt.creation_payload);
  const configuration=await readCharacteristicConfiguration(db,product.categoryCode);
  const readiness=await readCreationDeliveryReadiness(db,product.categoryCode,{normalizedAnswers:product.answers,weightVal:product.weight},
    options.config?{config:options.config}:{});
  const resolved=readiness.status==='no_native_upgrade_blocker';
  return {taskId:row.id,revision:String(row.revision),resolved,readiness,resolutionToken:resolved?
    c.hash({taskId:row.id,revision:String(row.revision),requestId:attempt.request_id,actor,readiness,configurationHash:configuration.config_hash}):null};
}
async function resolution(id,options={}) {
  return readTransaction(options,async(db,access)=>{
    if(!access.admin)throw c.error(403,'INTEGRATION_TASK_ACCESS_DENIED','Опрацювання потребує Administrator.');
    return inspectResolution(db,await taskRow(db,id,access),access.actor,options);
  });
}
async function resolve(id,input,options={}) {
  c.identity(id);c.object(input,['expectedRevision','resolutionToken']);
  if(typeof input.expectedRevision!=='string' || !/^[1-9][0-9]{0,17}$/.test(input.expectedRevision) || !c.HEX.test(input.resolutionToken))c.invalid();
  const context=createMutationContext(options.mutationContext);
  return runAccessAdminMutation({databasePool:options.databasePool || pool,actorUserId:context.actorUserId,
    requiredPermission:'export_templates.manage',createError:c.error,operation:async db=>{
      if(!await administrator(db,context.actorUserId))throw c.error(403,'INTEGRATION_TASK_ACCESS_DENIED','Опрацювання потребує Administrator.');
      const access={actor:context.actorUserId,admin:true};const row=await taskRow(db,id,access,true);
      if(row.state!=='open')throw c.error(409,'INTEGRATION_TASK_NOT_OPEN');
      if(String(row.revision)!==input.expectedRevision)throw c.error(409,'INTEGRATION_TASK_REVISION_STALE');
      await db.query('SELECT id FROM questions WHERE category_code=$1 FOR SHARE',[row.category_code]);
      await db.query('SELECT o.id FROM options o JOIN questions q ON q.id=o.question_id WHERE q.category_code=$1 FOR SHARE OF o',[row.category_code]);
      const inspected=await inspectResolution(db,row,context.actorUserId,options);
      if(!inspected.resolved)throw c.error(409,'INTEGRATION_TASK_NOT_READY','Поточна локальна конфігурація ще потребує підготовки.');
      if(inspected.resolutionToken!==input.resolutionToken)throw c.error(409,'INTEGRATION_TASK_RESOLUTION_STALE');
      await db.query(`UPDATE product_integration_tasks SET state='resolved',revision=revision+1,resolved_at=CURRENT_TIMESTAMP,
        resolved_by_user_id=$2,resolution_hash=$3 WHERE id=$1`,[id,context.actorUserId,input.resolutionToken]);
      await writeAuditEvent(db,{mutationContext:context,eventKey:'product.integration_task_resolved',subjectType:'product_integration_task',subjectId:id,
        details:{deliveryAccepted:false,localConfigurationOnly:true}});
      return present(db,await taskRow(db,id,access),access,true);
    }});
}
module.exports={create,read,list,recover,resolution,resolve,administrator};
