import { UUID_PATTERN } from './historical-reactivation.js';

export const historicalDeliveryBlockerLabels = Object.freeze({
  NAME_BASELINE_REQUIRED: 'Назви менеджера й Magento відрізняються. Спільні підтверджені назви ще не збережено.',
  NAME_CONFLICT: 'Назви змінено і в менеджері, і в Magento. Потрібно явно прийняти чинні назви.',
  NAME_EXTERNAL_CHANGE_PENDING: 'Чинні назви Magento ще не прийнято в менеджері.',
  NAME_READ_UNAVAILABLE: 'Не вдалося перевірити чинні назви Magento.',
  NAME_REMOTE_IDENTITY_CHANGED: 'Magento ID відрізняється від підтвердженого відповідника.',
  MAGENTO_NATIVE_IDENTITY_COLLISION: 'Належність відповідника Magento цьому товару не підтверджено.',
  DOMAIN_POLICY_REVIEW_REQUIRED: 'Поведінка передавання поля потребує окремого підтвердження.',
  ATTRIBUTE_NOT_IN_SELECTED_SET: 'Характеристика відсутня в обраному наборі Magento.',
});
const repairCodes = new Set(['NAME_BASELINE_REQUIRED', 'NAME_CONFLICT', 'NAME_EXTERNAL_CHANGE_PENDING']);
export function historicalNameRepairRequest(item) {
  if (item.protocol !== 'standard-rest-v1' || item.disposition !== 'blocked' || item.reasonCode !== 'HISTORICAL_DELIVERY_PLAN_BLOCKED'
    || item.deliveryMode !== 'update' || !Number.isSafeInteger(item.productId) || item.productId <= 0
    || !Number.isSafeInteger(item.remoteProductId) || item.remoteProductId <= 0 || !item.article
    || !UUID_PATTERN.test(item.bindingRevisionId) || !item.deliveryBlockerCodes?.some(code => repairCodes.has(code))
    || item.prerequisites.some(condition => !condition.met && condition.code !== 'CURRENT_DELIVERY_PLAN_VALID')) return null;
  return { productId: item.productId, article: item.article, remoteProductId: item.remoteProductId,
    bindingRevisionId: item.bindingRevisionId, choice: 'magento', intent: 'historical' };
}
const invalid = () => { throw new Error('Сервер не підтвердив точні назви й відповідник цього товару. Повторіть перевірку назв.'); };
export function validateHistoricalNames(value, request) {
  if (!value || value.productId !== request.productId || value.article !== request.article || value.remoteProductId !== request.remoteProductId
    || value.bindingRevisionId !== request.bindingRevisionId || value.intent !== 'historical' || value.choice !== 'magento'
    || typeof value.alreadyAccepted !== 'boolean' || !/^[a-f0-9]{64}$/.test(value.previewToken || '')
    || !Number.isFinite(Date.parse(value.reviewExpiresAt)) || Date.parse(value.reviewExpiresAt) <= Date.now()
    || ['all', 'en'].some(key => typeof value.magento?.[key] !== 'string' || !value.magento[key].trim()
      || value.magento[key].length > 1024 || Array.from(value.magento[key]).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) invalid();
  return value;
}
export function validateHistoricalNameReceipt(value, request) {
  if (!value || value.productId !== request.productId || value.article !== request.article || value.remoteProductId !== request.remoteProductId
    || value.bindingRevisionId !== request.bindingRevisionId || value.choice !== 'magento' || value.state !== 'archived' || value.baselineSaved !== true) invalid();
  return value;
}
