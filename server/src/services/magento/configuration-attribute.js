const pool = require('../../db/pool');
const c = require('./binding-contract');
const shape = require('./attribute-create-contract');
const actions = require('./configuration-actions');
const { createMagentoClient, readJson } = require('./client');
const { boundedGet } = require('./integration-readiness');
const { signAttributeCreateRequest } = require('./oauth');
const { validateBaseUrl } = require('../../config/magento');
const { createMutationContext } = require('../../audit/mutation-context');
const { assertActorStillAuthorized } = require('../access-admin-transaction');
const { fail } = shape;
const ASSIGN_FIELDS = ['bindingRevisionId','expectedRevision','attributeCode','attributeSetId','attributeGroupId','sortOrder'];

async function checkedAdministrator(client, actor) {
  const found = await client.query(`SELECT 1 FROM application_users u
    JOIN user_role_assignments a ON a.application_user_id=u.id AND a.revoked_at IS NULL
    JOIN roles r ON r.id=a.role_id AND r.status='active' AND r.role_key='administrator'
    WHERE u.id=$1 AND u.status='active'`, [actor]);
  if (!found.rowCount) throw c.error(403,'MAGENTO_ATTRIBUTE_ADMINISTRATOR_REQUIRED','Створення атрибутів і підключення до наборів доступні лише Адміністратору.');
}
async function authorize(options) {
  const db = options.databasePool || pool;
  const actor = createMutationContext(options.mutationContext).actorUserId;
  await assertActorStillAuthorized(db, actor, 'export_templates.manage', c.error, {readOnly:true});
  await assertActorStillAuthorized(db, actor, 'export_templates.publish', c.error, {readOnly:true});
  await checkedAdministrator(db, actor);
}
async function revisionFor(config, input, options) {
  await authorize(options);
  const revision = await require('./binding.service').getRevision(c.identity(input.bindingRevisionId), options);
  if (revision.originHash !== c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') c.invalid();
  if (revision.state !== 'draft' || revision.revision !== c.counter(input.expectedRevision)) {
    fail('MAGENTO_BINDING_CONFLICT','Чернетка змінилася. Оновіть налаштування перед перевіркою.');
  }
  return revision;
}
function remote(config, options) {
  return createMagentoClient(config, { fetchImpl: boundedGet(options.fetchImpl, {maxRequests:12}) });
}
async function stores(client) {
  const views = c.list(await client.getStoreViews(),1000);
  const english = views.filter((view) => view?.code === 'en');
  if (english.length > 1 || english.some((view) => !c.positive(view.id) || ![true,false,0,1].includes(view.is_active))) c.invalid();
  return english.find((view) => view.is_active === true || view.is_active === 1)?.id || null;
}
async function setContext(client, id) {
  const set = await client.getAttributeSet(id);
  if (set?.attribute_set_id !== id || typeof set.attribute_set_name !== 'string' || !set.attribute_set_name) c.invalid();
  return { set: {id, name:set.attribute_set_name}, groups: shape.groups(await client.getAttributeSetGroups(id),id),
    members: shape.membership(await client.getAttributeSetAttributes(id)) };
}
async function context(config, input, options = {}) {
  c.command(input,['bindingRevisionId','expectedRevision'],['attributeSetId']);
  const revision = await revisionFor(config,input,options); const client = remote(config,options);
  const result = { sets: revision.schema.attributeSets.map((set) => ({id:set.attribute_set_id,name:set.attribute_set_name})),
    englishStoreId: await stores(client), groups:[], members:[] };
  if (input.attributeSetId !== undefined) {
    const setId = Number(input.attributeSetId);
    if (!c.positive(setId) || !result.sets.some((set)=>set.id===setId)) c.invalid();
    Object.assign(result, await setContext(client,setId));
  }
  return result;
}
async function preview(config, input, options = {}) {
  c.command(input,shape.CREATE_FIELDS);
  const revision = await revisionFor(config,input,options); const client = remote(config,options);
  const englishStoreId = await stores(client); const body = shape.creation(input,englishStoreId);
  if (await client.findProductAttribute(input.attributeCode)) {
    fail('MAGENTO_ATTRIBUTE_ALREADY_EXISTS','Атрибут із цим кодом уже існує. Виберіть наявний атрибут; створення не змінює його.');
  }
  const result = {kind:'attribute',bindingRevisionId:revision.id,expectedRevision:revision.revision,
    origin:validateBaseUrl(config.baseUrl),installationKey:revision.installationKey,
    resource:{attributeCode:input.attributeCode},target:{attributeCode:input.attributeCode},
    label:input.label,englishStoreId,body, verificationContract:'new-attribute-profile-v1'};
  return {...result,previewToken:c.hash(result)};
}
async function assignmentPreview(config,input,options={}) {
  c.command(input,ASSIGN_FIELDS);
  const revision = await revisionFor(config,input,options);
  if (!c.code(input.attributeCode) || !c.positive(input.attributeSetId) || !c.positive(input.attributeGroupId)
    || !Number.isSafeInteger(input.sortOrder) || input.sortOrder < 1 || input.sortOrder > 100000
    || !revision.schema.attributeSets.some((set)=>set.attribute_set_id===input.attributeSetId)) c.invalid();
  const client = remote(config,options);
  const attribute = shape.safeAttribute(await client.getProductAttribute(input.attributeCode));
  if (attribute.attribute_code !== input.attributeCode || !shape.bool(attribute.is_user_defined)
    || !['text','select'].includes(attribute.frontend_input)) {
    fail('MAGENTO_ATTRIBUTE_ASSIGNMENT_UNSUPPORTED','Підключення доступне для власного текстового атрибута або вибору одного варіанта.');
  }
  const target = await setContext(client,input.attributeSetId);
  const group = target.groups.find((item)=>item.id===input.attributeGroupId);
  if (!group) fail('MAGENTO_ATTRIBUTE_GROUP_CHANGED','Розділ атрибутів у вибраному наборі змінився.');
  if (target.members.some((item)=>item.id===attribute.attribute_id || item.code===input.attributeCode)) {
    fail('MAGENTO_ATTRIBUTE_ALREADY_ASSIGNED','Атрибут уже доступний у цьому наборі. Повторне підключення або переміщення не потрібне.');
  }
  const result = {kind:'attribute_assignment',bindingRevisionId:revision.id,expectedRevision:revision.revision,
    origin:validateBaseUrl(config.baseUrl),installationKey:revision.installationKey,
    resource:{attributeCode:input.attributeCode,attributeId:attribute.attribute_id,setId:input.attributeSetId},
    target:{attributeCode:input.attributeCode,attributeId:attribute.attribute_id,set:target.set,group},
    label:attribute.default_frontend_label || input.attributeCode,attributeFingerprint:c.hash(attribute),
    membersBefore:target.members,groupsHash:c.hash(target.groups),
    body:{attributeSetId:input.attributeSetId,attributeGroupId:input.attributeGroupId,attributeCode:input.attributeCode,sortOrder:input.sortOrder},
    verificationContract:'exact-attribute-set-membership-v1'};
  return {...result,previewToken:c.hash(result)};
}
// Called by the ledger inside every mutation boundary, including after remote
// work. An ordinary delegated publisher cannot bypass Administrator authority.
async function checkedSource(client, config, intent, actor) {
  await checkedAdministrator(client,actor);
  if (!['attribute','attribute_assignment'].includes(intent.kind) || c.originHash(config.baseUrl)!==c.originHash(intent.origin)) c.invalid();
}
function receipt(row) {
  const base = actions.receipt(row);
  return {...base,attributeSet:row.intent.target.set || null,
    canReconcile:row.state==='returned' || (row.kind==='attribute_assignment' && row.state==='dispatched'),
    assignmentPlacementVerified:false,
    message:row.state==='verified' ? row.kind==='attribute' ? 'Атрибут створено та перевірено. Підключіть його до потрібного набору.'
      : 'Атрибут доступний у вибраному наборі. Правила передачі ще потрібно підключити.' : base.message};
}
async function reconcile(config,input,options={}) {
  c.command(input,['actionId']); await authorize(options);
  let row = await actions.get(config,input.actionId,options);
  if (!['attribute','attribute_assignment'].includes(row.kind)) c.invalid();
  if (row.state==='verified') return receipt(row);
  if (row.state!=='returned' && !(row.kind==='attribute_assignment' && row.state==='dispatched')) {
    fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED','Точний результат створення не збережено. Повторне надсилання недоступне.');
  }
  const client = remote(config,options); const attribute = await client.getProductAttribute(row.intent.target.attributeCode);
  let proof;
  if (row.kind==='attribute') {
    if (await stores(client)!==row.intent.englishStoreId) fail('MAGENTO_ATTRIBUTE_EN_SCOPE_CHANGED','Мовні магазини змінилися після створення.');
    proof=shape.verifyCreated(row.intent,row.remote_id,attribute);
  } else {
    shape.safeAttribute(attribute);
    if (attribute.attribute_id!==row.intent.target.attributeId || c.hash(attribute)!==row.intent.attributeFingerprint) {
      fail('MAGENTO_ATTRIBUTE_VERIFICATION_FAILED','Ідентичність або налаштування атрибута змінилися.');
    }
    const current=await setContext(client,row.intent.target.set.id);
    const match=current.members.filter((item)=>item.id===attribute.attribute_id && item.code===attribute.attribute_code);
    if (current.set.name!==row.intent.target.set.name || match.length!==1
      || row.intent.membersBefore.some((before)=>!current.members.some((item)=>item.id===before.id && item.code===before.code))) {
      fail('MAGENTO_ATTRIBUTE_MEMBERSHIP_UNVERIFIED','Доступність атрибута у вибраному наборі ще не підтверджено.');
    }
    proof={attributeId:attribute.attribute_id,attributeCode:attribute.attribute_code,setId:current.set.id,
      membershipVerified:true,placementVerified:false,membersHash:c.hash(current.members)};
    // Assignment targets an already-known exact attribute, so a lost response
    // can be reconciled by desired membership. No association-ID attribution or
    // assertion about stock REST's unobservable group/order is manufactured.
    if (row.state==='dispatched') row=await actions.transition(row.id,'dispatched','returned',{remoteId:String(attribute.attribute_id)},options);
  }
  return receipt(await actions.transition(row.id,'returned','verified',proof,options));
}
async function execute(config,input,options,assignment) {
  c.command(input,[...(assignment?ASSIGN_FIELDS:shape.CREATE_FIELDS),'previewToken']);
  const {previewToken,...command}=input;
  const inspect=assignment?assignmentPreview:preview;
  const reviewed=await inspect(config,command,options);
  if (reviewed.previewToken!==previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE','Налаштування змінилися. Перевірте їх ще раз.');
  const row=await actions.seal(config,reviewed,options);
  const fresh=await inspect(config,command,options);
  if (fresh.previewToken!==previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE','Підстава перевірки змінилася перед надсиланням.');
  await actions.transition(row.id,'sealed','dispatched',{},options);
  const url=`${validateBaseUrl(config.baseUrl)}/rest/all/V1/products/${assignment?'attribute-sets/attributes':'attributes'}`;
  let response;
  try {
    response=await (options.fetchImpl||globalThis.fetch)(url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/json','Content-Type':'application/json',Authorization:signAttributeCreateRequest(url,config)},body:JSON.stringify(reviewed.body)});
    if (!response.ok) throw new Error('Unverified remote response');
    const returned=await readJson(response);
    const id=assignment ? reviewed.target.attributeId : returned?.attribute_id;
    if (!c.positive(id) || (assignment ? !c.positive(returned) : returned.attribute_code!==reviewed.target.attributeCode)) throw new Error('Unverified identity');
    await actions.transition(row.id,'dispatched','returned',{remoteId:String(id)},options);
  } catch {
    throw c.error(409,'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED','Зміну надіслано. Перевірте її збережений результат; повторне надсилання недоступне.',{actionId:row.id});
  } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(()=>{}); }
  try { return await reconcile(config,{actionId:row.id},options); }
  catch { throw c.error(409,'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED','Зміну надіслано, але перевірка ще не завершена.',{actionId:row.id}); }
}
const apply=(config,input,options={})=>execute(config,input,options,false);
const assignmentApply=(config,input,options={})=>execute(config,input,options,true);
module.exports={context,preview,apply,assignmentPreview,assignmentApply,reconcile,receipt,checkedSource,checkedAdministrator};
