const { randomUUID } = require('node:crypto');
const pool = require('../../db/pool');
const c = require('../magento/binding-contract');
const { createCatalogDeleteTransport } = require('../magento/catalog-delete-transport');
const { readImpact } = require('./catalog-deletion-impact');
const { createMutationContext } = require('../../audit/mutation-context');
const { writeAuditEvent } = require('../../audit/audit-events');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');

const REVIEW_FIELDS = ['bindingRevisionId','expectedRevision','type','questionId','optionId','attributeCode','attributeId','remoteOptionId'];
const ACK_FIELDS = ['ackBothCatalogs','ackHistoryPreserved','ackExternalDependenciesReviewed','ackMagentoMaintenanceWindow','ackOrdinaryAttribute'];
const LOCK_TABLES = 'categories,questions,options,products,price_scenarios,price_modifiers,export_template_drafts,export_template_activation,magento_binding_revisions,magento_binding_attributes,magento_binding_options,magento_configuration_actions';
function normalize(input,config) {
  c.command(input,REVIEW_FIELDS);
  const questionId = c.counter(input.questionId);
  if (!['question','option'].includes(input.type) || !c.code(input.attributeCode) || !c.positive(input.attributeId)) c.invalid();
  const optionId = input.type === 'option' ? c.counter(input.optionId) : null;
  const remoteOptionId = input.type === 'option' ? c.counter(input.remoteOptionId) : null;
  if (input.type === 'question' && (input.optionId !== null || input.remoteOptionId !== null)) c.invalid();
  if (optionId && (!c.positive(Number(optionId)) || !c.positive(Number(remoteOptionId)))) c.invalid();
  return {bindingRevisionId:c.identity(input.bindingRevisionId),expectedRevision:c.counter(input.expectedRevision),type:input.type,questionId,optionId,
    target:{attributeCode:input.attributeCode,attributeId:input.attributeId,optionId:remoteOptionId},originHash:c.originHash(config.baseUrl)};
}
async function administrator(db,actor) {
  const result = await db.query(`SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id AND a.revoked_at IS NULL
    JOIN roles r ON r.id=a.role_id AND r.status='active' AND r.role_key='administrator' WHERE u.id=$1 AND u.status='active'`,[actor]);
  if (!result.rowCount) throw c.error(403,'CATALOG_DELETE_ADMINISTRATOR_REQUIRED','Повне видалення з обох каталогів доступне лише Адміністратору.');
}
async function authorize(db,options,readOnly=true) {
  const actor = createMutationContext(options.mutationContext).actorUserId;
  for (const permission of ['catalog.manage','export_templates.manage','export_templates.publish']) await assertActorStillAuthorized(db,actor,permission,c.error,{readOnly});
  await administrator(db,actor);
}
async function mutate(options,operation) {
  const context = createMutationContext(options.mutationContext);
  return runAccessAdminMutation({databasePool:options.databasePool || pool,actorUserId:context.actorUserId,requiredPermission:'catalog.manage',createError:c.error,
    operation:async db => { await authorize(db,options,false); return operation(db,context); }});
}
async function local(db,command) {
  const revision = (await db.query('SELECT id,revision,origin_hash,installation_key FROM magento_binding_revisions WHERE id=$1',[command.bindingRevisionId])).rows[0];
  if (!revision || revision.origin_hash !== command.originHash || String(revision.revision) !== command.expectedRevision) throw c.error(409,'CATALOG_DELETE_BINDING_CHANGED','Контекст Magento змінився; повторіть перевірку.');
  const observed = (await db.query('SELECT attribute_id FROM magento_binding_schema_attributes WHERE revision_id=$1 AND code=$2',[revision.id,command.target.attributeCode])).rows[0];
  if (!observed || Number(observed.attribute_id) !== command.target.attributeId) throw c.error(409,'CATALOG_DELETE_TARGET_UNRESOLVED','Точний атрибут відсутній у перевіреному контексті.');
  const impact = await readImpact(db,command);
  return {revision,impact,localHash:c.hash({revision,impact})};
}
function ordinary(attribute,target,type) {
  // Magento REST omits a null backend_model on an ordinary Table attribute.
  if (!attribute || attribute.attribute_code !== target.attributeCode || attribute.attribute_id !== target.attributeId
    || ![true,1,'1'].includes(attribute.is_user_defined) || !['text','select','multiselect'].includes(attribute.frontend_input)
    || ![false,0,'0'].includes(attribute.is_required) || ![null,'',undefined].includes(attribute.backend_model)
    || (attribute.frontend_input === 'text' ? ![null,''].includes(attribute.source_model)
      : attribute.source_model !== 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table')
    || (type === 'option' && attribute.frontend_input === 'text')
    || JSON.stringify(attribute.extension_attributes || {}).toLowerCase().includes('swatch')) {
    throw c.error(409,'CATALOG_DELETE_ATTRIBUTE_UNSUPPORTED','Системний, обов’язковий, спеціальний або непідтверджений тип атрибута не можна видалити.');
  }
  if (type === 'option' && String(attribute.default_value || '').split(',').includes(target.optionId)) throw c.error(409,'CATALOG_DELETE_DEFAULT_OPTION','Варіант є типовим значенням атрибута.');
}
function safeOptions(raw) {
  if (!Array.isArray(raw) || raw.length > 1000 || raw.some(item => typeof item?.value !== 'string' || typeof item.label !== 'string')
    || new Set(raw.map(item => item.value)).size !== raw.length) c.invalid();
  return raw.filter(item => item.value !== '').sort((a,b)=>a.value.localeCompare(b.value,'en'));
}
function metadataHash(attribute) { const {options,...metadata} = attribute; void options; return c.hash(metadata); }
async function observation(config,command,options) {
  const remote = createCatalogDeleteTransport(config,options);
  const attribute = await remote.attribute(command.target); ordinary(attribute,command.target,command.type);
  const scopes=await remote.stores();
  const scopedOptions=[]; const scopedProducts=[]; const observedOptionIds=new Set();
  for(const scope of scopes) {
    const values=attribute.frontend_input==='text' ? [] : safeOptions(await remote.options(command.target,scope.code));
    for (const value of values) observedOptionIds.add(value.value);
    scopedOptions.push({storeId:scope.id,storeCode:scope.code,optionsHash:c.hash(values),remainingOptionsHash:c.hash(values.filter(value=>value.value!==command.target.optionId))});
    scopedProducts.push(...(await remote.products(command.target,attribute.frontend_input,scope.code)).map(product=>({...product,storeCode:scope.code})));
  }
  const values = attribute.frontend_input === 'text' ? [] : safeOptions(await remote.options(command.target));
  if (command.type === 'option' && !values.some(value => value.value === command.target.optionId)) throw c.error(409,'CATALOG_DELETE_REMOTE_OPTION_MISSING','Точний Magento option ID не знайдено.');
  const products = scopedProducts;
  const sets = await remote.sets(command.target);
  return {attributeLabel:attribute.default_frontend_label || command.target.attributeCode,frontendInput:attribute.frontend_input,
    ...(options.includeOptionIds ? {optionIds:[...new Set([...values.map(value=>value.value),...observedOptionIds])].sort()} : {}),
    attributeHash:metadataHash(attribute),optionsHash:c.hash(values),remainingOptionsHash:c.hash(values.filter(value => value.value !== command.target.optionId)),
    selectedRemoteLabel:values.find(value => value.value === command.target.optionId)?.label || null,products,sets,scopes,scopedOptions,
    blockers:[...(products.length ? ['MAGENTO_PRODUCTS_DEPEND_ON_TARGET'] : []),...(sets.length > 1 ? ['SHARED_ATTRIBUTE_SETS'] : [])]};
}
function confirmationFor(command,impact) {
  return command.type === 'question' ? `DELETE QUESTION ${command.questionId} / ATTRIBUTE ${command.target.attributeCode}#${command.target.attributeId}`
    : `DELETE OPTION ${command.optionId} / ${impact.question.category_code}.${impact.question.key}=value_id:${impact.selectedOptions[0].value_id} / MAGENTO ${command.target.attributeCode}#${command.target.attributeId}:${command.target.optionId}`;
}
async function preview(config,input,options={}) {
  const db = options.databasePool || pool; await authorize(db,options);
  const command = normalize(input,config); const source = await local(db,command);
  const remote = await observation(config,command,options);
  const after = await local(db,command); await authorize(db,options);
  if (after.localHash !== source.localHash) throw c.error(409,'CATALOG_DELETE_STALE','Локальні залежності змінилися під час перевірки.');
  const result = {kind:command.type === 'question' ? 'attribute_delete' : 'option_delete',command,localHash:source.localHash,
    installationKey:source.revision.installation_key,localTarget:{questionId:command.questionId,optionId:command.optionId,categoryCode:source.impact.question.category_code,
      questionKey:source.impact.question.key,label:command.type === 'question' ? source.impact.question.label : source.impact.selectedOptions[0].label,
      valueId:command.type === 'option' ? source.impact.selectedOptions[0].value_id : null},remote,
    affected:{products:source.impact.products,pricing:source.impact.pricing.map(({type,id})=>({type,id})),rules:source.impact.rules.map(({type,id})=>({type,id})),
      templates:source.impact.templates,bindings:source.impact.bindings,sharedMappings:source.impact.sharedMappings,historicalSchemas:source.impact.historicalSchemas,
      options:source.impact.selectedOptions.map(({id,value_id,label})=>({id,valueId:value_id,label}))},
    blockers:[...source.impact.blockers,...remote.blockers],confirmationText:confirmationFor(command,source.impact),
    historicalEvidencePreserved:true,futureSkuPublicationRequired:source.impact.historicalSchemas.length>0,externalDependenciesAutomaticallyVerified:false};
  // The permanent ledger holds hashes and bounded projections, never a huge report.
  c.safeData(result,[],24000);
  return {...result,previewToken:c.hash(result)};
}
function attest(input,fresh) {
  if (ACK_FIELDS.some(key => input[key] !== true) || input.confirmationText !== fresh.confirmationText
    || typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 1000) throw c.error(422,'CATALOG_DELETE_CONFIRMATION_REQUIRED','Потрібні точне підтвердження дії, причина та всі перевірки залежностей.');
}
async function audit(db,context,row,event,details={}) {
  await writeAuditEvent(db,{mutationContext:context,eventKey:`catalog.full_delete.${event}`,subjectType:'magento_configuration_action',subjectId:row.id,
    details:{kind:row.kind,target:row.intent.command.target,localTarget:row.intent.localTarget,...details}});
}
function receipt(row,completion=row.state==='verified' ? {completed_at:row.verified_at} : null) {
  return {id:row.id,kind:row.kind,state:completion ? 'completed' : row.state,localTarget:row.intent.localTarget,remoteTarget:row.intent.command.target,
    createdAt:row.created_at,completedAt:completion?.completed_at || null,historicalEvidencePreserved:true,workflow:'catalog_deletion',canReview:false,
    remoteAbsent:row.state === 'verified',localDeleted:!!completion,canReconcile:row.state !== 'sealed' && !completion,
    message:completion ? 'Вилучено з активних каталогів Manager і Magento. Історичні дані збережено.'
      : row.state === 'verified' ? 'Відсутність у Magento підтверджено; локальне завершення ще не виконано.'
        : 'Намір видалення зафіксовано. Кінцевий результат ще не підтверджено; повторний DELETE недоступний.'};
}
async function getRow(config,id,options) {
  c.identity(id); const db = options.databasePool || pool;
  const row = (await db.query("SELECT * FROM magento_configuration_actions WHERE id=$1 AND origin_hash=$2 AND kind IN ('attribute_delete','option_delete')",[id,c.originHash(config.baseUrl)])).rows[0];
  if (!row) throw c.error(404,'CATALOG_DELETE_ACTION_NOT_FOUND','Дію видалення не знайдено.');
  return row;
}
async function completed(db,id) { return (await db.query('SELECT * FROM catalog_deletion_completions WHERE action_id=$1',[id])).rows[0] || null; }
async function get(config,id,options={}) {
  const db=options.databasePool || pool; await authorize(db,options); const row=await getRow(config,id,options); return receipt(row,await completed(db,id));
}
async function list(config,options={}) {
  const db=options.databasePool || pool; await authorize(db,options);
  const rows=(await db.query("SELECT * FROM magento_configuration_actions WHERE origin_hash=$1 AND kind IN ('attribute_delete','option_delete') ORDER BY created_at DESC,id LIMIT 100",[c.originHash(config.baseUrl)])).rows;
  const results=[]; for(const row of rows) results.push(receipt(row,await completed(db,row.id))); return results;
}
async function apply(config,input,options={}) {
  c.command(input,[...REVIEW_FIELDS,'previewToken','confirmationText','reason',...ACK_FIELDS]);
  const db=options.databasePool || pool; await authorize(db,options);
  const review=Object.fromEntries(REVIEW_FIELDS.map(key=>[key,input[key]])); const command=normalize(review,config);
  // The same resource reservation permanently prevents a replay from dispatching
  // again, including a restart after Magento deleted it but the response was lost.
  const resourceKey=c.hash(command.target);
  const prior=(await db.query("SELECT * FROM magento_configuration_actions WHERE origin_hash=$1 AND kind=$2 AND resource_key=$3 AND state<>'superseded'",[command.originHash,command.type==='question'?'attribute_delete':'option_delete',resourceKey])).rows[0];
  if(prior) {
    attest(input,prior.intent);
    if(prior.preview_hash!==input.previewToken || c.hash(prior.intent.command)!==c.hash(command) || prior.intent.reason!==input.reason.trim()) throw c.error(409,'CATALOG_DELETE_REVIEW_CONFLICT','Цей ресурс уже має інший незмінний намір видалення.',{actionId:prior.id});
    return receipt(prior,await completed(db,prior.id));
  }
  const fresh=await preview(config,review,options); attest(input,fresh);
  if(fresh.previewToken!==input.previewToken || fresh.blockers.length) throw c.error(409,'CATALOG_DELETE_BLOCKED','Перевірка застаріла або є залежності.',{blockers:fresh.blockers});
  const row=await mutate(options,async(client,context)=>{
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query(`LOCK TABLE ${LOCK_TABLES} IN SHARE ROW EXCLUSIVE MODE`);
    const checked=await local(client,command);
    if(checked.localHash!==fresh.localHash || checked.impact.blockers.length) throw c.error(409,'CATALOG_DELETE_STALE','Залежності змінилися перед видаленням.');
    const pending=(await client.query(`SELECT id FROM magento_configuration_actions WHERE origin_hash=$1 AND state IN ('sealed','dispatched','returned')
      AND (intent #>> '{command,target,attributeCode}'=$2 OR intent #>> '{target,attributeCode}'=$2)`,[command.originHash,command.target.attributeCode])).rows;
    if(pending.length) throw c.error(409,'CATALOG_DELETE_PENDING_CONFIGURATION','Є незавершена зміна цього атрибута.',{actionIds:pending.map(item=>item.id)});
    const intent={...fresh,reason:input.reason.trim(),attestations:Object.fromEntries(ACK_FIELDS.map(key=>[key,true]))};
    const sealed=(await client.query(`INSERT INTO magento_configuration_actions (id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,[randomUUID(),fresh.kind,command.originHash,resourceKey,command.bindingRevisionId,command.expectedRevision,context.actorUserId,fresh.previewToken,JSON.stringify(intent)])).rows[0];
    await audit(client,context,sealed,'sealed');
    const dispatched=(await client.query("UPDATE magento_configuration_actions SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[sealed.id])).rows[0];
    await audit(client,context,dispatched,'dispatched'); return dispatched;
  });
  // Dispatch intent is already committed; never wrap remote I/O in a transaction.
  try { await createCatalogDeleteTransport(config,options).remove(command.target); }
  catch { return {...receipt(row),reconciliationRequired:true}; }
  try { return await reconcile(config,{actionId:row.id},options); }
  catch(error) { return {...receipt(row),reconciliationRequired:true,blockerCode:error.code || 'CATALOG_DELETE_RECONCILIATION_REQUIRED'}; }
}
async function absence(config,row,options) {
  const remote=createCatalogDeleteTransport(config,options); const target=row.intent.command.target;
  const attribute=await remote.attribute(target);
  if(row.kind==='attribute_delete') {
    if(attribute) throw c.error(409,'CATALOG_DELETE_REMOTE_STILL_PRESENT','Атрибут ще існує або його код уже використано повторно. Повторний DELETE недоступний.');
  } else {
    ordinary(attribute,target,'option');
    if(metadataHash(attribute)!==row.intent.remote.attributeHash) throw c.error(409,'CATALOG_DELETE_REMOTE_CHANGED','Метадані атрибута змінилися після видалення.');
    const scopes=await remote.stores();
    if(c.hash(scopes)!==c.hash(row.intent.remote.scopes)) throw c.error(409,'CATALOG_DELETE_REMOTE_CHANGED','Мовні магазини змінилися після видалення.');
    for(const scope of scopes) {
      const values=safeOptions(await remote.options(target,scope.code));
      const expected=row.intent.remote.scopedOptions.find(item=>item.storeId===scope.id && item.storeCode===scope.code);
      if(!expected || values.some(value=>value.value===target.optionId) || c.hash(values)!==expected.remainingOptionsHash) throw c.error(409,'CATALOG_DELETE_REMOTE_STILL_PRESENT','Варіант ще існує або інші варіанти змінилися.');
    }
  }
  return {attributeCode:target.attributeCode,attributeId:target.attributeId,optionId:target.optionId,absent:true,observedAt:new Date().toISOString(),contract:'catalog-exact-absence-v1'};
}
async function reconcile(config,input,options={}) {
  c.command(input,['actionId']); const db=options.databasePool || pool; await authorize(db,options);
  const row=await getRow(config,input.actionId,options); const done=await completed(db,row.id); if(done) return receipt(row,done);
  if(!['dispatched','returned','verified'].includes(row.state)) throw c.error(409,'CATALOG_DELETE_NOT_DISPATCHED','Цю дію не було надіслано.');
  // GET only even when the original DELETE response was lost. Exact target IDs
  // were permanently captured before dispatch, unlike create's unknown result ID.
  const proof=await absence(config,row,options);
  return mutate(options,async(client,context)=>{
    await client.query("SET LOCAL lock_timeout='5s'"); await client.query(`LOCK TABLE ${LOCK_TABLES} IN SHARE ROW EXCLUSIVE MODE`);
    let current=(await client.query('SELECT * FROM magento_configuration_actions WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
    const existing=await completed(client,row.id); if(existing) return receipt(current,existing);
    const checked=await local(client,current.intent.command);
    if(checked.localHash!==current.intent.localHash || checked.impact.blockers.length) throw c.error(409,'CATALOG_DELETE_LOCAL_CHANGED','Magento вже перевірено, але локальні залежності змінилися. Потрібне ручне узгодження.',{actionId:row.id});
    if(current.state==='dispatched') {
      const exactId=current.intent.command.target.optionId || String(current.intent.command.target.attributeId);
      current=(await client.query("UPDATE magento_configuration_actions SET state='returned',remote_id=$2,returned_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[row.id,exactId])).rows[0];
      await audit(client,context,current,'absence_observed');
    }
    if(current.state==='returned') {
      current=(await client.query("UPDATE magento_configuration_actions SET state='verified',verification=$2::jsonb,verified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[row.id,JSON.stringify(proof)])).rows[0];
      await audit(client,context,current,'remote_verified');
    }
    await client.query("SELECT set_config('amber.catalog_deletion_action',$1,true)",[row.id]);
    const removed=await client.query(current.intent.command.type==='question' ? 'DELETE FROM questions WHERE id=$1 RETURNING id' : 'DELETE FROM options WHERE id=$1 AND question_id=$2 RETURNING id',
      current.intent.command.type==='question' ? [current.intent.command.questionId] : [current.intent.command.optionId,current.intent.command.questionId]);
    if(removed.rowCount!==1) throw c.error(409,'CATALOG_DELETE_LOCAL_CHANGED','Локальну ціль не знайдено; успішне видалення не підтверджено.');
    const completion=(await client.query(`INSERT INTO catalog_deletion_completions (action_id,actor_user_id,local_target,remote_verification)
      VALUES($1,$2,$3::jsonb,$4::jsonb) RETURNING *`,[row.id,context.actorUserId,JSON.stringify(current.intent.localTarget),JSON.stringify(proof)])).rows[0];
    await audit(client,context,current,'completed',{preserved:['products','sku_schema_versions','sku_schema_questions','sku_schema_options','sku_registry','public_product_identities','export_snapshots','published_templates','published_bindings']});
    return receipt(current,completion);
  });
}
module.exports = { preview, apply, reconcile, get, list, normalize, ordinary, safeOptions, confirmationFor, receipt, administrator,
  authorize, mutate, observation, absence };
