import { UUID_PATTERN } from './historical-reactivation.js';

const hasControls = value => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const validText = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !hasControls(value);
const invalid = () => { throw new Error('Сервер не підтвердив ручну пару й точний CREATE-кандидат. Перевірте назви ще раз.'); };
export function historicalManualNameRequest(item) {
  if (item.protocol !== 'standard-rest-v1' || item.disposition !== 'blocked' || item.reasonCode !== 'HISTORICAL_DELIVERY_PLAN_BLOCKED'
    || item.manualNameCompletion !== true || item.category !== 'SV' || item.deliveryMode !== 'create' || item.remoteProductId !== null
    || !Number.isSafeInteger(item.productId) || item.productId <= 0 || !item.article || !UUID_PATTERN.test(item.bindingRevisionId)
    || item.prerequisites.some(condition => !condition.met && condition.code !== 'CURRENT_DELIVERY_PLAN_VALID')) return null;
  return { productId: item.productId, article: item.article, bindingRevisionId: item.bindingRevisionId, intent: 'historical-create' };
}
function scope(value, request) {
  if (!value || value.productId !== request.productId || value.article !== request.article
    || value.bindingRevisionId !== request.bindingRevisionId || value.intent !== request.intent || value.remoteProductId !== null) invalid();
}
export function validateHistoricalManualNames(value, request, subjects = null) {
  scope(value, request);
  if (value.deliveryMode !== 'create' || typeof value.alreadyCompleted !== 'boolean'
    || ['subjectUa', 'subjectEn'].some(key => value[key] !== null && (typeof value[key] !== 'string' || value[key].length > 200 || hasControls(value[key])))) invalid();
  if (subjects || value.alreadyCompleted) {
    if (!validText(value.nameUa, 1024) || !validText(value.nameEn, 1024)
      || !validText(value.subjectUa, 200) || !validText(value.subjectEn, 200)) invalid();
  }
  if (subjects && (value.subjectUa !== subjects.subjectUa.trim() || value.subjectEn !== subjects.subjectEn.trim()
    || !/^[a-f0-9]{64}$/.test(value.previewToken || '') || !Number.isFinite(Date.parse(value.reviewExpiresAt))
    || Date.parse(value.reviewExpiresAt) <= Date.now())) invalid();
  return value;
}
export function validateHistoricalManualNameReceipt(value, request, preview) {
  scope(value, request);
  if (value.state !== 'archived' || value.subjectsSaved !== true || value.subjectUa !== preview.subjectUa || value.subjectEn !== preview.subjectEn) invalid();
  return value;
}
