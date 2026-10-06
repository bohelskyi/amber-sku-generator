const {randomUUID}=require('node:crypto');
const pool=require('../../db/pool');
const c=require('../magento/binding-contract');
const full=require('./catalog-deletion.service');
const {readImpact,mentions}=require('./catalog-deletion-impact');
const {createCatalogDeleteTransport}=require('../magento/catalog-delete-transport');
const {writeAuditEvent}=require('../../audit/audit-events');
const REVIEW=['bindingRevisionId','expectedRevision','type','questionId','optionId','attributeCode','attributeId','remoteOptionId'];
const ACK=['ackRemoteOnly','ackHistoryPreserved','ackExternalDependenciesReviewed','ackMagentoMaintenanceWindow','ackOrdinaryAttribute'];
const LOCKS='categories,questions,options,products,price_scenarios,price_modifiers,export_template_drafts,export_template_activation,magento_binding_revisions,magento_binding_attributes,magento_binding_options,magento_configuration_actions,magento_remote_catalog_deletions';
async function local(db,command){
 const revision=(await db.query('SELECT id,revision,origin_hash,installation_key FROM magento_binding_revisions WHERE id=$1',[command.bindingRevisionId])).rows[0];
 if(!revision||revision.origin_hash!==command.originHash||String(revision.revision)!==command.expectedRevision)throw c.error(409,'CATALOG_DELETE_BINDING_CHANGED','Контекст Magento змінився.');
 const observed=(await db.query('SELECT attribute_id FROM magento_binding_schema_attributes WHERE revision_id=$1 AND code=$2',[revision.id,command.target.attributeCode])).rows[0];
 if(Number(observed?.attribute_id)!==command.target.attributeId)throw c.error(409,'CATALOG_DELETE_TARGET_UNRESOLVED','Потрібна точна перевірена ідентичність атрибута.');
 const impact=await readImpact(db,command),q=impact.question;
 const creation=(await db.query(`SELECT id FROM magento_configuration_actions WHERE origin_hash=$1 AND kind='attribute' AND state='verified'
  AND remote_id=$2 AND intent#>>'{target,attributeCode}'=$3 AND intent->>'label' ~ '^TEST( |$)'`,[command.originHash,String(command.target.attributeId),command.target.attributeCode])).rows;
 const products=(await db.query(`SELECT id,status,full_sku FROM products WHERE category=$1
  AND details->'answers'-> $2 IS NOT NULL AND details->'answers'-> $2 NOT IN ('null'::jsonb,'""'::jsonb)
  AND ($3::text IS NULL OR details#>>ARRAY['answers',$2]=$3) ORDER BY id LIMIT 101`,
 [q.category_code,q.key,command.type==='option'?String(impact.selectedOptions[0].value_id):null])).rows;
 const pricing=impact.pricing.filter(p=>mentions(p.data,q.key));
 // Remote-only removal retains the local source. Immutable source contracts and
 // inert drafts are evidence, not remote delivery. Only active output columns or
 // the latest published remote mapping establish an operational dependency.
 const templates=(await db.query(`SELECT v.id,v.definition FROM export_template_versions v
  JOIN export_template_activation a ON a.template_version_id=v.id ORDER BY v.id`)).rows
  .filter(row=>row.definition.groups.some(group=>group.columns.includes(command.target.attributeCode)
   || group.rows.some(row=>Object.hasOwn(row.cells,command.target.attributeCode))))
  .map(row=>({id:row.id,state:'active'}));
 const bindings=impact.bindings.filter(row=>row.state==='published');
 const retainedDraftReferences=impact.bindings.filter(row=>row.state==='draft');
 const blockers=[];
 // This repair is confined to the TEST namespace. It grants no remote-only
 // deletion of an ordinary archived business attribute, even if Amber created it.
 if(!/^test_[a-z0-9_]+$/.test(q.key)||!/^TEST(?:\s|$)/.test(q.label))blockers.push('REMOTE_ONLY_TEST_NAMESPACE_REQUIRED');
 if(q.key!==command.target.attributeCode||Number(q.include_in_sku)!==0||creation.length!==1)blockers.push('REMOTE_ONLY_OWNED_ATTRIBUTE_PROOF_REQUIRED');
 if((command.type==='question'&&!q.archived)||impact.selectedOptions.some(o=>!o.archived))blockers.push('REMOTE_ONLY_ARCHIVE_REQUIRED');
 for(const [rows,code] of [[products,'LOCAL_PRODUCTS_DEPEND_ON_TARGET'],[pricing,'LOCAL_PRICING_DEPENDS_ON_TARGET'],[impact.rules,'LOCAL_RULES_DEPEND_ON_QUESTION'],
  [templates,'ACTIVE_TEMPLATE_DEPENDENCY'],[bindings,'BINDING_DEPENDENCY'],[impact.sharedMappings.filter(row=>bindings.some(binding=>binding.id===row.revision_id)),'SHARED_REMOTE_RESOURCE']])if(rows.length)blockers.push(code);
 if(products.length>100)blockers.push('LOCAL_SCOPE_LIMIT');
 if(command.type==='option'){
  const proof=(await db.query(`SELECT id FROM magento_configuration_actions WHERE origin_hash=$1 AND kind='option' AND state='verified' AND remote_id=$2
   AND intent#>>'{target,attributeCode}'=$3 AND intent->>'attributeId'=$4 AND intent#>>'{target,questionKey}'=$5
   AND intent#>>'{target,valueId}'=$6 AND intent#>>'{target,amberGroup}'=$7`,[command.originHash,command.target.optionId,command.target.attributeCode,String(command.target.attributeId),q.key,String(impact.selectedOptions[0].value_id),q.category_code])).rows;
  if(proof.length!==1)blockers.push('REMOTE_ONLY_OWNED_OPTION_PROOF_REQUIRED');
 }
 const ownedOptions=(await db.query(`SELECT id,remote_id,intent#>>'{target,valueId}' value_id FROM magento_configuration_actions
  WHERE origin_hash=$1 AND kind='option' AND state='verified' AND intent#>>'{target,attributeCode}'=$2 AND intent->>'attributeId'=$3
   AND intent#>>'{target,questionKey}'=$4 AND intent#>>'{target,amberGroup}'=$5 ORDER BY id`,[command.originHash,command.target.attributeCode,String(command.target.attributeId),q.key,q.category_code])).rows
  .filter(row=>impact.selectedOptions.some(o=>String(o.value_id)===row.value_id));
 const context={revision,question:q,selectedOptions:impact.selectedOptions,products,pricing,rules:impact.rules,templates,retainedTemplates:impact.templates,ownedOptions,retainedDraftReferences,
  bindings,mappings:impact.mappings,sharedMappings:impact.sharedMappings,historicalSchemas:impact.historicalSchemas,creation,blockers};
 return {context,localHash:c.hash(context)};
}
function confirmation(command){return `DELETE MAGENTO ONLY ${command.target.attributeCode}#${command.target.attributeId}${command.target.optionId===null?'':':'+command.target.optionId} / KEEP ARCHIVED QUESTION ${command.questionId}${command.optionId===null?'':' OPTION '+command.optionId}`;}
async function preview(config,input,options={}){
 const db=options.databasePool||pool;await full.authorize(db,options);
 const command=full.normalize(input,config),before=await local(db,command),remote=await full.observation(config,command,{...options,includeOptionIds:true}),after=await local(db,command);
 await full.authorize(db,options);if(before.localHash!==after.localHash)throw c.error(409,'CATALOG_DELETE_STALE','Залежності змінилися під час перевірки.');
 const result={kind:command.type==='question'?'attribute_delete_remote':'option_delete_remote',command,localHash:before.localHash,remote,
  localTarget:{questionId:command.questionId,optionId:command.optionId,categoryCode:before.context.question.category_code,questionKey:before.context.question.key,label:command.type==='question'?before.context.question.label:before.context.selectedOptions[0].label,
   valueId:command.type==='option'?before.context.selectedOptions[0].value_id:null},
  affected:{...before.context,options:before.context.selectedOptions.map(o=>({id:o.id,valueId:o.value_id,label:o.label}))},blockers:[...before.context.blockers,...remote.blockers,
   ...(command.type==='question'&&remote.optionIds.some(id=>!before.context.ownedOptions.some(o=>o.remote_id===id))?['REMOTE_ONLY_FOREIGN_OPTION']:[])],confirmationText:confirmation(command),
  localArchiveRetained:true,localDeleted:false,historicalEvidencePreserved:true,externalDependenciesAutomaticallyVerified:false};
 c.safeData(result,[],24000);return {...result,previewToken:c.hash(result)};
}
function attest(input,review){if(ACK.some(k=>input[k]!==true)||input.confirmationText!==review.confirmationText
 ||typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>1000)throw c.error(422,'CATALOG_DELETE_CONFIRMATION_REQUIRED','Потрібні точне підтвердження, причина і перевірки залежностей.');}
const receipt=row=>({id:row.id,kind:row.kind,state:row.state==='verified'?'completed':row.state,remoteTarget:row.intent.command.target,localTarget:row.intent.localTarget,
 localArchived:true,localDeleted:false,historicalEvidencePreserved:true,remoteAbsent:row.state==='verified',
 message:row.state==='verified'?'Відсутність у Magento підтверджено. Архів у Manager та історію збережено.':'Намір видалення лише з Magento зафіксовано. Потрібна перевірка результату без повторного DELETE.',canReconcile:['dispatched','returned'].includes(row.state)});
async function audit(db,context,row,event){await writeAuditEvent(db,{mutationContext:context,eventKey:'catalog.remote_delete.'+event,subjectType:'magento_remote_catalog_deletion',subjectId:row.id,
 details:{remoteTarget:row.intent.command.target,localTarget:row.intent.localTarget,localDeleted:false}});}
async function getRow(config,id,options){c.identity(id);const row=(await (options.databasePool||pool).query('SELECT * FROM magento_remote_catalog_deletions WHERE id=$1 AND origin_hash=$2',[id,c.originHash(config.baseUrl)])).rows[0];
 if(!row)throw c.error(404,'CATALOG_DELETE_ACTION_NOT_FOUND','Дію не знайдено.');return row;}
async function get(config,id,options={}){await full.authorize(options.databasePool||pool,options);return receipt(await getRow(config,id,options));}
async function list(config,options={}){const db=options.databasePool||pool;await full.authorize(db,options);return (await db.query('SELECT * FROM magento_remote_catalog_deletions WHERE origin_hash=$1 ORDER BY created_at DESC,id LIMIT 100',[c.originHash(config.baseUrl)])).rows.map(receipt);}
async function apply(config,input,options={}){
 c.command(input,[...REVIEW,'previewToken','confirmationText','reason',...ACK]);const db=options.databasePool||pool;await full.authorize(db,options);
 const reviewInput=Object.fromEntries(REVIEW.map(k=>[k,input[k]])),command=full.normalize(reviewInput,config),resource=c.hash(command.target);
 const prior=(await db.query('SELECT * FROM magento_remote_catalog_deletions WHERE origin_hash=$1 AND resource_key=$2',[command.originHash,resource])).rows[0];
 if(prior){attest(input,prior.intent);if(prior.preview_hash!==input.previewToken||c.hash(prior.intent.command)!==c.hash(command)||prior.intent.reason!==input.reason.trim())throw c.error(409,'CATALOG_DELETE_REVIEW_CONFLICT','Існує інший незмінний намір.');return receipt(prior);}
 const fresh=await preview(config,reviewInput,options);attest(input,fresh);
 if(fresh.previewToken!==input.previewToken||fresh.blockers.length)throw c.error(409,'CATALOG_DELETE_BLOCKED','Є залежності або перевірка застаріла.',{blockers:fresh.blockers});
 const row=await full.mutate(options,async(client,context)=>{
  await client.query("SET LOCAL lock_timeout='5s'");await client.query(`LOCK TABLE ${LOCKS} IN SHARE ROW EXCLUSIVE MODE`);
  const checked=await local(client,command);if(checked.localHash!==fresh.localHash||checked.context.blockers.length)throw c.error(409,'CATALOG_DELETE_STALE','Залежності змінилися перед надсиланням.');
  if((await client.query(`SELECT id FROM magento_configuration_actions WHERE origin_hash=$1 AND state IN ('sealed','dispatched','returned')
   AND (intent#>>'{command,target,attributeCode}'=$2 OR intent#>>'{target,attributeCode}'=$2)
   UNION ALL SELECT id FROM magento_remote_catalog_deletions WHERE origin_hash=$1 AND state<>'verified'
    AND intent#>>'{command,target,attributeCode}'=$2`,[command.originHash,command.target.attributeCode])).rowCount)throw c.error(409,'CATALOG_DELETE_PENDING_CONFIGURATION','Є незавершена зміна цього ресурсу.');
  const intent={...fresh,reason:input.reason.trim(),attestations:Object.fromEntries(ACK.map(k=>[k,true]))};
  const saved=(await client.query(`INSERT INTO magento_remote_catalog_deletions(id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent,creation_action_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,[randomUUID(),fresh.kind,command.originHash,resource,command.bindingRevisionId,command.expectedRevision,context.actorUserId,fresh.previewToken,JSON.stringify(intent),checked.context.creation[0].id])).rows[0];
  await audit(client,context,saved,'sealed');const dispatched=(await client.query("UPDATE magento_remote_catalog_deletions SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[saved.id])).rows[0];
  await audit(client,context,dispatched,'dispatched');return dispatched;
 });
 try{await createCatalogDeleteTransport(config,options).remove(command.target);}catch{return {...receipt(row),reconciliationRequired:true};}
 try{return await reconcile(config,{actionId:row.id},options);}catch(e){return {...receipt(row),reconciliationRequired:true,blockerCode:e.code||'CATALOG_DELETE_RECONCILIATION_REQUIRED'};}
}
async function reconcile(config,input,options={}){
 c.command(input,['actionId']);const db=options.databasePool||pool;await full.authorize(db,options);const row=await getRow(config,input.actionId,options);
 if(row.state==='verified')return receipt(row);if(!['dispatched','returned'].includes(row.state))throw c.error(409,'CATALOG_DELETE_NOT_DISPATCHED','DELETE не було надіслано.');
 const proof=await full.absence(config,{...row,kind:row.intent.command.type==='question'?'attribute_delete':'option_delete'},options);
 return full.mutate(options,async(client,context)=>{
  await client.query("SET LOCAL lock_timeout='5s'");await client.query(`LOCK TABLE ${LOCKS} IN SHARE ROW EXCLUSIVE MODE`);
  let current=(await client.query('SELECT * FROM magento_remote_catalog_deletions WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(current.state==='verified')return receipt(current);
  const checked=await local(client,current.intent.command);if(checked.localHash!==current.intent.localHash||checked.context.blockers.length)throw c.error(409,'CATALOG_DELETE_LOCAL_CHANGED','Локальні залежності змінилися; повторний DELETE заборонено.');
  if(current.state==='dispatched'){current=(await client.query("UPDATE magento_remote_catalog_deletions SET state='returned',remote_id=$2,returned_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[row.id,current.intent.command.target.optionId||String(current.intent.command.target.attributeId)])).rows[0];await audit(client,context,current,'absence_observed');}
  current=(await client.query("UPDATE magento_remote_catalog_deletions SET state='verified',verification=$2::jsonb,verified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *",[row.id,JSON.stringify(proof)])).rows[0];
  await audit(client,context,current,'completed');return receipt(current);
 });
}
module.exports={preview,apply,reconcile,get,list,local,confirmation,receipt};
