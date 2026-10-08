import { UUID_PATTERN } from './historical-reactivation.js';
export const WEIGHT_FORMAT = 'historical-sv-weight-normalization-v1';
const intent = 'historical-weight-normalization';
const invalid = () => { throw new Error('Сервер не підтвердив точну вагу цього архівованого товару. Повторіть лише читання.'); };
function key(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || !(Number(value) > 0)) return null;
  const [integer, fraction = ''] = value.split('.');
  return (integer.replace(/^0+/, '') || '0') + '.' + fraction.replace(/0+$/, '');
}
function equivalent(source, target, canonical, completed = false) {
  return key(canonical) !== null && key(target) === key(canonical) && typeof source === 'string'
    && (completed ? source === target : /^\d+,\d+$/.test(source) && source.replace(',', '.') === target);
}
export function historicalWeightRequest(item) {
  const weight = item?.weightNormalization;
  if (item?.protocol !== 'standard-rest-v1' || item.category !== 'SV' || item.disposition !== 'blocked'
    || item.reasonCode !== 'HISTORICAL_DELIVERY_PLAN_BLOCKED' || item.currentRoute !== 'retired'
    || !Number.isSafeInteger(item.productId) || item.productId <= 0 || !item.article || !UUID_PATTERN.test(item.bindingRevisionId)
    || !weight || !equivalent(weight.sourceWeight, weight.targetWeight, weight.canonicalWeight)) return null;
  return { productId: item.productId, article: item.article, bindingRevisionId: item.bindingRevisionId, intent };
}
function same(value, request) {
  if (value?.format !== WEIGHT_FORMAT || value.productId !== request.productId || value.article !== request.article
    || value.bindingRevisionId !== request.bindingRevisionId || value.state !== 'archived' || !Array.isArray(value.remainingIssues)
    || value.remainingIssues.some(issue => typeof issue?.field !== 'string' || issue.field === 'decor_weight')) invalid();
}
export function validateWeightPreview(value, request, now = Date.now()) {
  same(value, request);
  if (typeof value.alreadyCompleted !== 'boolean' || !equivalent(value.sourceWeight, value.targetWeight, value.canonicalWeight, value.alreadyCompleted)) invalid();
  if (!value.alreadyCompleted && (!/^[a-f0-9]{64}$/.test(value.previewToken || '')
    || !Number.isFinite(Date.parse(value.reviewExpiresAt)) || Date.parse(value.reviewExpiresAt) <= now || Date.parse(value.reviewExpiresAt) > now + 300000)) invalid();
  return value;
}
export function validateWeightReceipt(value, request, preview) {
  same(value, request);
  if (value.weightNormalized !== true || value.sourceWeight !== preview.sourceWeight || value.targetWeight !== preview.targetWeight
    || value.canonicalWeight !== preview.canonicalWeight) invalid();
  return value;
}
