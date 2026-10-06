const { normalizeFlag } = require('./product/test-products');
const { randomUUID } = require('node:crypto');
const { hash } = require('./magento/binding-contract');
const { PublicHttpError } = require('../http/errors');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const error = (status,code,message='Оновіть перевірку інтеграції.') => new PublicHttpError(status,message,{code});
const invalid = () => {throw error(422,'VALIDATION_ERROR','Некоректні дані інтеграційної задачі.');};
function object(value,keys) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!keys.includes(key)))invalid();
}
function identity(value) {if(typeof value!=='string' || !UUID.test(value))invalid();return value;}
function productPayload(value) {
  object(value,['isTestProduct','categoryCode','answers','weight','isCalibrated','pricingDecision','photoIds','enableWhenPhotosVerified','magento_name_subject_ua','magento_name_subject_en']);
  normalizeFlag(value);
  if(typeof value.categoryCode!=='string' || !/^[A-Z0-9_-]{1,32}$/.test(value.categoryCode))invalid();
  if(!value.answers || typeof value.answers!=='object' || Array.isArray(value.answers) || Object.keys(value.answers).length>100)invalid();
  for(const [key,answer] of Object.entries(value.answers)) {
    if(!/^[A-Za-z0-9_]{1,128}$/.test(key) || (answer!==null && !['string','number','boolean'].includes(typeof answer))
      || typeof answer==='string' && (answer.length>4096 || /[\u0000-\u001f]/.test(answer))
      || typeof answer==='number' && !Number.isFinite(answer))invalid();
  }
  if(value.weight!==undefined && !['number','string'].includes(typeof value.weight))invalid();
  if(value.isCalibrated!==undefined && ![null,0,1,2].includes(value.isCalibrated))invalid();
  for(const field of ['magento_name_subject_ua','magento_name_subject_en']) {
    if(value[field]!==undefined && (typeof value[field]!=='string' || value[field].length>200 || /[\u0000-\u001f]/.test(value[field])))invalid();
  }
  if(value.enableWhenPhotosVerified!==undefined && typeof value.enableWhenPhotosVerified!=='boolean')invalid();
  if(value.pricingDecision!==undefined)object(value.pricingDecision,['mode','manualPriceUah','usdPerGram','marketingRoundingEnabled']);
  if(Buffer.byteLength(JSON.stringify(value))>32768)invalid();
  if(value.photoIds!==undefined) {
    if(!Array.isArray(value.photoIds) || value.photoIds.length>8 || new Set(value.photoIds).size!==value.photoIds.length)invalid();
    value.photoIds.forEach(identity);
  }
  return JSON.parse(JSON.stringify(value));
}
function creationCommand(input) {
  object(input,['clientRequestId','expectedPreviewToken','product']);
  identity(input.clientRequestId);
  if(!HEX.test(input.expectedPreviewToken))invalid();
  const product=productPayload(input.product);
  return {clientRequestId:input.clientRequestId,expectedPreviewToken:input.expectedPreviewToken,product,
    requestHash:hash({expectedPreviewToken:input.expectedPreviewToken,product})};
}
function defectOf(readiness) {
  if(readiness?.scope!=='native_characteristic_source_support' || readiness.status!=='configuration_required'
    || !['NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED','SOURCE_SUPPORT_DEFERRED_VALUE','MAGENTO_CATEGORY_NOT_LINKED','MAGENTO_SOURCE_VALUE_NOT_LINKED'].includes(readiness.code))
    throw error(409,'INTEGRATION_TASK_NOT_REQUIRED','Поточна перевірка не підтвердила цю потребу інтеграції.');
  return {categoryCode:readiness.categoryCode,questionKey:readiness.questionKey ?? null,valueId:readiness.valueId ?? null,
    reasonCode:readiness.code,message:String(readiness.message || 'Потрібна підготовка інтеграції.').slice(0,1000)};
}
function fingerprint(defect) {return hash({categoryCode:defect.categoryCode,questionKey:defect.questionKey,valueId:defect.valueId,reasonCode:defect.reasonCode});}
function links(row,owner) {
  const returnTo='/attention?integrationTask='+row.id;
  const params=new URLSearchParams({category:row.category_code,returnTo,
    intent:row.defect.reasonCode==='MAGENTO_CATEGORY_NOT_LINKED'?'connect':'rules'});
  if(row.defect.questionKey)params.set('question',row.defect.questionKey);
  if(row.defect.valueId!==null)params.set('value',String(row.defect.valueId));
  return {repairHref:'/admin/magento/prepare?'+params.toString(),resumeHref:owner?'/products/create?integrationTask='+row.id:null};
}
module.exports={UUID,HEX,error,invalid,object,identity,productPayload,creationCommand,defectOf,fingerprint,links,hash,randomUUID};
