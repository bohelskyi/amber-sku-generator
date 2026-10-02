const pool = require('../../db/pool');
const c = require('./binding-contract');
const option = require('./configuration-option');
const actions = require('./configuration-actions');
const bindings = require('./binding.service');
const repository = require('./binding-repository');
const { createMagentoClient, readJson } = require('./client');
const { boundedGet } = require('./integration-readiness');
const { createMutationContext } = require('../../audit/mutation-context');
const { signScopedOptionLabelRequest } = require('./oauth');
const FIELDS = ['bindingRevisionId','expectedRevision','attributeCode','amberGroup','questionKey','valueId'];
const CONTRACT = 'amber-scoped-option-labels-v1';
const fail = (code,message) => { throw c.error(409,code,message); };
async function approved(db,config,input,lock=false) {
  if (!c.code(input.attributeCode) || !c.questionKey(input.questionKey) || !c.semanticId(String(input.valueId))) c.invalid();
  const revision = await bindings.readRevisionOnClient(db,c.identity(input.bindingRevisionId));
  const current = await repository.current(db,revision.installationKey);
  if (revision.state !== 'published' || current?.id !== revision.id || revision.revision !== c.counter(input.expectedRevision)
    || revision.originHash !== c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all')
    fail('MAGENTO_BINDING_CONFLICT','Потрібна чинна опублікована відповідність.');
  const rows = (await db.query(`SELECT DISTINCT o.option_id,sa.attribute_id FROM magento_binding_options o
    JOIN magento_binding_attributes a ON a.revision_id=o.revision_id AND a.binding_key=o.binding_key
    JOIN magento_binding_schema_attributes sa ON sa.revision_id=a.revision_id AND sa.code=a.attribute_code
    JOIN magento_binding_routes r ON r.revision_id=a.revision_id AND r.route_key=a.route_key
    WHERE o.revision_id=$1 AND o.source_kind='semantic' AND o.amber_group=$2 AND o.question_key=$3 AND o.value_id=$4
      AND a.attribute_code=$5 AND o.review_state='approved' AND a.review_state='approved'
      AND r.review_state='approved' AND r.enabled=true`,[revision.id,input.amberGroup,input.questionKey,input.valueId,input.attributeCode])).rows;
  if (rows.length !== 1 || !/^[1-9][0-9]*$/.test(rows[0].option_id))
    fail('MAGENTO_OPTION_APPROVED_BINDING_REQUIRED','Потрібен точний затверджений зв’язок атрибута та варіанта.');
  const value = await option.amberSource(db,input,null,lock);
  return {...input,valueId:String(input.valueId),installationKey:revision.installationKey,
    optionId:rows[0].option_id,attributeId:Number(rows[0].attribute_id),label:option.label(value.label),
    ...(value.label_en != null ? {englishLabel:option.label(value.label_en)} : {})};
}
function adapterEvidence(raw,target,englishStoreId) {
  c.command(raw,['contractVersion','attributeId','attributeCode','optionId','revision','labels']);
  c.command(raw.labels,['all','en']);
  if (raw.contractVersion !== CONTRACT || raw.attributeId !== target.attributeId || raw.attributeCode !== target.attributeCode
    || raw.optionId !== target.optionId || !/^[a-f0-9]{64}$/.test(raw.revision) || typeof raw.labels.all !== 'string') c.invalid();
  if (englishStoreId) {
    c.command(raw.labels.en,['storeId','label']);
    if (raw.labels.en.storeId !== englishStoreId || (raw.labels.en.label !== null && typeof raw.labels.en.label !== 'string')) c.invalid();
  } else if (raw.labels.en !== null) c.invalid();
  return c.safeData(raw,[],16384);
}
async function observe(config,target,options,allowComparison=false) {
  const fetchImpl = boundedGet(options.fetchImpl,{maxRequests:6});
  const observed = await option.observe(config,target.attributeCode,{...options,fetchImpl});
  if (observed.attribute.attribute_id !== target.attributeId) fail('MAGENTO_OPTION_METADATA_DRIFT','Ідентичність атрибута змінилась.');
  if (!allowComparison && observed.englishStoreId && !target.englishLabel)
    fail('MAGENTO_OPTION_EN_LABEL_REQUIRED','Заповніть англійську назву варіанта в каталозі Amber.');
  let raw;
  try { raw = await createMagentoClient(config,{fetchImpl}).getScopedOptionLabels(target.attributeCode,target.optionId); }
  catch {
    const message='Безпечне оновлення недоступне без адаптера Magento. Стандартний PUT не буде надіслано.';
    if(allowComparison)return {...observed,remote:null,updateUnavailable:message};
    fail('MAGENTO_OPTION_LABEL_ADAPTER_REQUIRED',message);
  }
  const remote = adapterEvidence(raw,target,observed.englishStoreId);
  return {...observed,remote};
}
async function inspect(config,input,options={}) {
  c.command(input,FIELDS);
  const target = await approved(options.databasePool || pool,config,input);
  const checked = await observe(config,target,options,true);
  function effective(rows) {
    const matching=rows.filter(r=>r.value===target.optionId);
    if(matching.length!==1)fail('MAGENTO_OPTION_IDENTITY_MISSING','Точний затверджений варіант не знайдено в Magento.');
    return matching[0].label;
  }
  const comparison=[{scope:'all',before:checked.remote ? checked.remote.labels.all : effective(checked.before),after:target.label},
    ...(checked.englishStoreId ? [{scope:'en',before:checked.remote ? checked.remote.labels.en.label : effective(checked.englishBefore),after:target.englishLabel ?? null}] : [])];
  return {target,...checked,comparison,comparisonKind:checked.remote ? 'stored' : 'effective',
    warning:'Administrator перевіряє звичайний select/multiselect для цієї дії. Адаптер змінює лише перевірені назви, зберігає порядок та інші переклади й атомарно перевіряє revision.'};
}
function requireWritable(checked) {
  if(checked.updateUnavailable)fail('MAGENTO_OPTION_LABEL_ADAPTER_REQUIRED',checked.updateUnavailable);
  if(checked.englishStoreId && !checked.target.englishLabel)
    fail('MAGENTO_OPTION_EN_LABEL_REQUIRED','Заповніть англійську назву варіанта в каталозі Amber.');
}
async function attest(config,input,options={}) {
  c.command(input,[...FIELDS,'metadataFingerprint','confirmOrdinary','confirmHiddenLimit','evidence']);
  if (input.confirmOrdinary !== true || input.confirmHiddenLimit !== true || typeof input.evidence !== 'string'
    || input.evidence.trim().length < 3 || input.evidence.length > 2000) c.invalid();
  const checked = await inspect(config,Object.fromEntries(FIELDS.map(k=>[k,input[k]])),options);
  requireWritable(checked);
  if (checked.metadataFingerprint !== input.metadataFingerprint) fail('MAGENTO_OPTION_ATTESTATION_STALE','Повторіть перевірку атрибута.');
  return option.recordAttestation(config,checked,input.evidence,options);
}
async function checkedSource(client,config,preview,actor) {
  await option.checkedAttestation(client,config,preview,actor);
  const target = await approved(client,config,Object.fromEntries(FIELDS.map(k=>[k,preview.target[k]])),true);
  if (c.hash(target) !== c.hash(preview.target)) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE','Каталог або затверджена відповідність змінились.');
}
async function preview(config,input,options={}) {
  c.command(input,[...FIELDS,'attestationId']);
  const {attestationId,...command}=input,checked=await inspect(config,command,options);
  requireWritable(checked);
  const {target,remote}=checked;
  const differences=[{scope:'all',before:remote.labels.all,after:target.label},
    ...(checked.englishStoreId ? [{scope:'en',before:remote.labels.en.label,after:target.englishLabel}] : [])].filter(d=>d.before!==d.after);
  if (!differences.length) fail('MAGENTO_OPTION_LABELS_CURRENT','Назви вже відповідають каталогу Amber.');
  const result={kind:'option_label',bindingRevisionId:target.bindingRevisionId,expectedRevision:target.expectedRevision,
    target,origin:config.baseUrl,attestationId:c.identity(attestationId),attributeId:target.attributeId,
    metadataFingerprint:checked.metadataFingerprint,remote,differences,label:target.label,
    resource:{attributeId:target.attributeId,attributeCode:target.attributeCode,optionId:target.optionId},
    body:{expectedRevision:remote.revision,labels:{all:target.label,en:checked.englishStoreId ? {storeId:checked.englishStoreId,label:target.englishLabel} : null}}};
  await checkedSource(options.databasePool || pool,config,result,createMutationContext(options.mutationContext).actorUserId);
  return {...result,previewToken:c.hash(result)};
}
async function reconcile(config,input,options={}) {
  c.command(input,['actionId']); const row=await actions.get(config,input.actionId,options);
  if (row.kind!=='option_label') c.invalid();
  if (row.state==='verified') return actions.receipt(row);
  if (!['dispatched','returned'].includes(row.state)) fail('MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED','Дію не було надіслано.');
  // Never PUT here, including after a lost response. The exact target was known
  // before dispatch, so GET can confirm it without inferring a created identity.
  const checked=await observe(config,row.intent.target,options),wanted=row.intent.body.labels;
  if (checked.metadataFingerprint!==row.intent.metadataFingerprint || c.hash(checked.remote.labels)!==c.hash(wanted))
    fail('MAGENTO_OPTION_VERIFICATION_FAILED','Точні назви ще не підтверджено. Повторне надсилання заборонено.');
  if (row.state==='dispatched') await actions.transition(row.id,'dispatched','returned',{remoteId:row.intent.target.optionId},options);
  return actions.receipt(await actions.transition(row.id,'returned','verified',{remoteId:row.intent.target.optionId,remote:checked.remote},options));
}
async function apply(config,input,options={}) {
  c.command(input,[...FIELDS,'attestationId','previewToken']);
  const {previewToken,...command}=input,reviewed=await preview(config,command,options);
  if (reviewed.previewToken!==previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE','Повторіть перегляд змін.');
  const row=await actions.seal(config,reviewed,options);
  if ((await preview(config,command,options)).previewToken!==previewToken) fail('MAGENTO_CONFIGURATION_PREVIEW_STALE','Повторіть перегляд змін.');
  await actions.transition(row.id,'sealed','dispatched',{},options);
  const url=`${config.baseUrl}/rest/all/V1/amber/attributes/${reviewed.target.attributeCode}/options/${reviewed.target.optionId}/labels`;
  try {
    const response=await (options.fetchImpl || globalThis.fetch)(url,{method:'PUT',redirect:'manual',signal:AbortSignal.timeout(10000),
      headers:{Accept:'application/json','Content-Type':'application/json',Authorization:signScopedOptionLabelRequest(url,config)},body:JSON.stringify(reviewed.body)});
    try {
      if (!response.ok || await readJson(response)!==true) throw new Error('Unconfirmed response');
      await actions.transition(row.id,'dispatched','returned',{remoteId:reviewed.target.optionId},options);
    } finally { if(response.body && !response.body.locked) await response.body.cancel().catch(()=>{}); }
  } catch {
    throw c.error(409,'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED','Amber надіслав зміну назв, але не підтвердив результат. Доступна лише перевірка читанням.',{actionId:row.id});
  }
  return reconcile(config,{actionId:row.id},options);
}
module.exports={inspect,attest,preview,apply,reconcile,checkedSource,adapterEvidence,CONTRACT};
