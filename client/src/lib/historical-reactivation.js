import { isActualAdministrator } from '../auth/auth-model.js';

export const HISTORICAL_REACTIVATION_FORMAT = 'historical-reactivation-v1';
export const HISTORICAL_STANDARD_FORMAT = 'historical-reactivation-standard-v1';
export const HISTORICAL_STANDARD_PROTOCOL = 'standard-rest-v1';
export const isStandardHistorical = (value) => value?.protocol === HISTORICAL_STANDARD_PROTOCOL;
export const HISTORICAL_REACTIVATION_PERMISSIONS = Object.freeze([
  'products.view', 'products.archive', 'history.view', 'export_templates.manage', 'export_templates.publish',
]);
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/i;
const dispositions = new Set(['eligible', 'blocked', 'skipped']);
const states = new Set(['queued', 'dispatched', 'blocked', 'awaiting_native', 'completed']);
const standardStates = new Set(['queued', 'delivering', 'blocked', 'cancelled', 'completed']);
const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const timestamp = (value) => value == null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const invalid = () => { throw new Error('Сервер повернув неповну перевірку історичного рішення. Повторіть читання або передайте номер операції Адміністратору.'); };

export function historicalCapability(config) {
  const value = config?.historicalReactivation;
  return Boolean(value?.available === true
    && (value.format === HISTORICAL_STANDARD_FORMAT && value.protocol === HISTORICAL_STANDARD_PROTOCOL && value.createTargetStatus === 2
      || value.format === HISTORICAL_REACTIVATION_FORMAT && value.targetStatus === 2)
    && value.administratorOnly === true
    && Number.isSafeInteger(value.maxItems) && value.maxItems > 0 && value.maxItems <= 100);
}
export function canUseHistoricalReactivation(auth, config) {
  return historicalCapability(config) && isActualAdministrator(auth)
    && HISTORICAL_REACTIVATION_PERMISSIONS.every((permission) => auth.permissions?.includes(permission));
}
export function historicalInput(text, maxItems = 100) {
  const skus = String(text || '').split(/[\r\n]+/).map((sku) => sku.trim()).filter(Boolean);
  if (!skus.length || skus.length > maxItems) throw new Error('Вкажіть від 1 до ' + maxItems + ' точних артикулів, по одному в рядку.');
  return skus;
}
export function validateHistoricalPreview(value) {
  const standard = value?.format === HISTORICAL_STANDARD_FORMAT && isStandardHistorical(value);
  if ((!standard && (value?.format !== HISTORICAL_REACTIVATION_FORMAT || value.protocol != null)) || !UUID_PATTERN.test(value.reviewNonce)
    || !hash.test(value.reviewHash) || !nonempty(value.reviewToken)
    || !nonempty(value.reviewExpiresAt) || !timestamp(value.reviewExpiresAt)
    || !Array.isArray(value.skus) || !value.skus.length || value.skus.length > 100 || !value.skus.every(nonempty)
    || !Array.isArray(value.items) || !value.counts) invalid();
  if (value.items.length !== value.skus.length || new Set(value.skus).size !== value.skus.length
    || value.items.some((item, index) => item.inputSku !== value.skus[index])) invalid();
  const eligible = [];
  for (const item of value.items) {
    if (!nonempty(item.inputSku) || !dispositions.has(item.disposition) || (!standard && item.targetStatus !== 2) || standard && !isStandardHistorical(item)
      || item.priorFacts !== 'unknown' || !Array.isArray(item.prerequisites)
      || !item.prerequisites.every((condition) => nonempty(condition.code) && typeof condition.met === 'boolean')
      || !Array.isArray(item.blockerCodes) || !item.blockerCodes.every(nonempty)) invalid();
    if (item.currentName != null && (typeof item.currentName !== 'string' || !item.currentName.trim())) invalid();
    if (item.disposition === 'eligible') {
      if (!nonempty(item.article) || !positiveId(item.productId)
        || item.prerequisites.some((condition) => !condition.met) || item.blockerCodes.length) invalid();
      if (standard) {
        if (!['update', 'create'].includes(item.deliveryMode) || ![1, 2].includes(item.targetStatus)
          || ![1, 2, 3, 4].includes(item.targetVisibility) || !hash.test(item.deliveryPlanHash)
          || item.requiresExplicitCreate !== (item.deliveryMode === 'create')
          || !item.prerequisites.some((condition) => condition.code === 'CURRENT_DELIVERY_PLAN_VALID' && condition.met)
          || item.deliveryMode === 'update' && (!positiveId(item.remoteProductId)
            || item.observedRemoteStatus !== item.targetStatus || item.observedRemoteVisibility !== item.targetVisibility)
          || item.deliveryMode === 'create' && (item.remoteProductId !== null || item.targetStatus !== 2)) invalid();
      } else if (!positiveId(item.remoteProductId)
        || !item.prerequisites.some((condition) => condition.code === 'ATOMIC_UPDATE_ONLY_SUPPORTED' && condition.met)) invalid();
      eligible.push(item.article);
    }
  }
  if (new Set(eligible).size !== eligible.length) invalid();
  for (const disposition of dispositions) {
    if (!Number.isSafeInteger(value.counts[disposition])
      || value.counts[disposition] !== value.items.filter((item) => item.disposition === disposition).length) invalid();
  }
  return value;
}
export function historicalConfirmation(review, selectedSkus, idempotencyKey, now = Date.now(), selectedCreateSkus = []) {
  validateHistoricalPreview(review);
  if (!UUID_PATTERN.test(idempotencyKey) || Date.parse(review.reviewExpiresAt) <= now) {
    throw new Error('Перевірка застаріла. Оновіть її перед підтвердженням нового рішення.');
  }
  const eligible = new Set(review.items.filter((item) => item.disposition === 'eligible').map((item) => item.article));
  if (!selectedSkus.length || new Set(selectedSkus).size !== selectedSkus.length
    || selectedSkus.some((sku) => !eligible.has(sku))) throw new Error('Оберіть лише точні дозволені артикули з цієї перевірки.');
  const standard = isStandardHistorical(review);
  const requiredCreate = review.items.filter((item) => selectedSkus.includes(item.article) && item.deliveryMode === 'create').map((item) => item.article);
  if (standard && (new Set(selectedCreateSkus).size !== selectedCreateSkus.length
    || selectedCreateSkus.length !== requiredCreate.length || requiredCreate.some((sku) => !selectedCreateSkus.includes(sku)))) {
    throw new Error('Окремо підтвердіть CREATE кожного обраного відсутнього відповідника.');
  }
  return Object.freeze({
    skus: Object.freeze([...review.skus]), selectedSkus: Object.freeze([...selectedSkus]),
    reviewNonce: review.reviewNonce, reviewHash: review.reviewHash, reviewToken: review.reviewToken,
    reviewExpiresAt: review.reviewExpiresAt, idempotencyKey,
    ...(standard ? { selectedCreateSkus: Object.freeze([...selectedCreateSkus]), confirmCurrentFactsAndStandardDelivery: true }
      : { confirmCurrentFactsAndHiddenUpdate: true }),
  });
}
export function validateHistoricalReceipt(value, expectedBatchId) {
  if (!UUID_PATTERN.test(value?.batchId) || expectedBatchId && value.batchId !== expectedBatchId
    || !nonempty(value.createdAt) || !timestamp(value.createdAt) || !Array.isArray(value.items) || !value.items.length) invalid();
  if (value.protocol != null && !isStandardHistorical(value)) invalid();
  const standard = isStandardHistorical(value);
  const seen = new Set(), articles = new Set();
  for (const item of value.items) {
    if (!UUID_PATTERN.test(item.intentId) || !positiveId(item.productId) || !nonempty(item.article)
      || seen.has(item.intentId) || articles.has(item.article) || !(standard ? standardStates : states).has(item.state)
      || (!standard && item.targetStatus !== 2)
      || !timestamp(item.hiddenVerifiedAt) || !timestamp(item.localActivatedAt) || !timestamp(item.nativeConfirmedAt)) invalid();
    if (standard) {
      if (!isStandardHistorical(item) || !['update', 'create'].includes(item.deliveryMode)
        || ![1, 2].includes(item.targetStatus) || ![1, 2, 3, 4].includes(item.targetVisibility) || item.hiddenVerifiedAt !== null
        || item.deliveryMode === 'update' && !positiveId(item.remoteProductId)
        || item.deliveryMode === 'create' && (item.remoteProductId !== null || item.targetStatus !== 2)
        || item.nativeJobId != null && !UUID_PATTERN.test(item.nativeJobId)
        || !timestamp(item.deliveryVerifiedAt) || !timestamp(item.cancelledAt)
        || item.deliveryVerifiedAt && (!UUID_PATTERN.test(item.nativeJobId) || !positiveId(item.confirmedRemoteProductId)
          || !item.nativeConfirmedAt || Date.parse(item.nativeConfirmedAt) !== Date.parse(item.deliveryVerifiedAt))
        || !item.deliveryVerifiedAt && (item.confirmedRemoteProductId != null || item.nativeConfirmedAt)
        || item.deliveryMode === 'update' && item.deliveryVerifiedAt && Number(item.confirmedRemoteProductId) !== Number(item.remoteProductId)
        || item.localActivatedAt && !item.deliveryVerifiedAt
        || item.state === 'completed' && (!item.deliveryVerifiedAt || !item.localActivatedAt)
        || item.state === 'cancelled' && (!item.cancelledAt || item.deliveryVerifiedAt || item.localActivatedAt)) invalid();
    } else if (item.protocol != null || item.state === 'completed' && (!item.hiddenVerifiedAt || !item.localActivatedAt || !item.nativeConfirmedAt)
      || item.state === 'awaiting_native' && (!item.hiddenVerifiedAt || !item.localActivatedAt || item.nativeConfirmedAt)) invalid();
    seen.add(item.intentId); articles.add(item.article);
  }
  return value;
}
export function validateHistoricalInspection(value, item) {
  if (isStandardHistorical(item)) {
    validateHistoricalReceipt({ batchId: item.intentId, createdAt: new Date().toISOString(), protocol: HISTORICAL_STANDARD_PROTOCOL, items: [value] });
    if (value.intentId !== item.intentId || value.article !== item.article || Number(value.productId) !== Number(item.productId)
      || value.deliveryMode !== item.deliveryMode || value.targetStatus !== item.targetStatus || value.targetVisibility !== item.targetVisibility
      || Number(value.remoteProductId) !== Number(item.remoteProductId)
      || item.nativeJobId && value.nativeJobId !== item.nativeJobId
      || !['canReconcile', 'canContinue', 'canCancel'].every((key) => typeof value[key] === 'boolean')
      || value.canCancel && (value.canReconcile || value.canContinue || ['completed', 'cancelled'].includes(value.state))
      || (value.canReconcile || value.canContinue) && (!UUID_PATTERN.test(value.nativeJobId)
        || !value.recoveryReview || typeof value.recoveryReview !== 'object' || Array.isArray(value.recoveryReview)
        || value.recoveryReview.jobId !== value.nativeJobId || !hash.test(value.recoveryReviewHash))) invalid();
    return value;
  }
  if (value?.intentId !== item.intentId || value.article !== item.article || !states.has(value.state)
    || value.targetStatus !== 2 || typeof value.canConfirm !== 'boolean' || !hash.test(value.reviewHash)
    || value.canConfirm && (!positiveId(value.expectedMagentoId)
      || Number(value.expectedMagentoId) !== Number(value.observedMagentoId) || value.observedStatus !== 2)) invalid();
  return value;
}
export function historicalPending(receipt) {
  return Boolean(receipt?.items.some((item) => (isStandardHistorical(item) ? ['queued', 'delivering'] : ['queued', 'dispatched', 'awaiting_native']).includes(item.state)));
}

export const historicalPrerequisiteLabels = Object.freeze({
  LOCAL_ARCHIVED_CURRENT: 'Чинний локальний товар архівований',
  LINEAGE_CLEAR: 'Немає наступника чи виправленої версії',
  MEDIA_CLEAR: 'Передавання фотографій не має незавершеного результату',
  DELETION_CLEAR: 'Немає незавершеного видалення',
  SYNC_CLEAR: 'Немає незавершеної або невизначеної доставки',
  CURRENT_PRICE_VALID: 'Чинна ціна придатна для передавання',
  AUTOMATIC_DELIVERY_ENABLED: 'Автоматична доставка доступна',
  CURRENT_BINDING_VALID: 'Чинні правила та їхня публікація перевірені',
  EXACT_REMOTE_COUNTERPART: 'Точний існуючий відповідник Magento підтверджений',
  ATOMIC_UPDATE_ONLY_SUPPORTED: 'Атомарний UPDATE лише існуючого відповідника підтримується адаптером Magento',
  REVIEWED_REMOTE_OBSERVATION: 'Точний відповідник або його відсутність перевірені',
  CURRENT_DELIVERY_PLAN_VALID: 'Поточні дані, назви, відповідності та план доставки перевірені',
});
export const historicalReasonLabels = Object.freeze({
  HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED: 'Потрібен перевірений адаптер атомарного UPDATE лише існуючого відповідника. Стандартний запис Magento може створити товар і тут не застосовується.',
  HISTORICAL_REMOTE_OBSERVATION_CHANGED: 'Відповідник або його стан змінився. Потрібна нова перевірка.',
  HISTORICAL_ATOMIC_INTENT_EXISTS: 'Залишається попереднє атомарне рішення; прочитайте його первісний результат.',
  HISTORICAL_STANDARD_REVIEW_REQUIRED: 'Потрібна окрема свіжа перевірка чинного плану доставки.',
  HISTORICAL_ORIGINAL_ACTOR_REQUIRED: 'Продовження потребує первісного уповноваженого Адміністратора.',
  HISTORICAL_DELIVERY_RECONCILIATION_REQUIRED: 'Прочитайте результат первісної операції доставки; повторний запис не допускається.',
  HISTORICAL_DUPLICATE_TARGET: 'Інший артикул у цьому переліку вже визначає той самий товар. Повторний учасник пропущений.',
  HISTORICAL_PRODUCT_NOT_FOUND: 'Локальний товар не знайдено. Створення за цим артикулом не допускається.',
  HISTORICAL_PRODUCT_AMBIGUOUS: 'Артикул має неоднозначного власника.',
  HISTORICAL_PRODUCT_ALREADY_ACTIVE: 'Товар уже активний; нове історичне рішення не потрібне.',
  HISTORICAL_PRODUCT_NOT_ARCHIVED: 'Товар не перебуває у придатному архівному стані.',
  HISTORICAL_LINEAGE_BLOCKED: 'Є наступник або виправлена версія.',
  HISTORICAL_MEDIA_UNRESOLVED: 'Спочатку перевірте незавершене передавання фотографій.',
  HISTORICAL_TEST_DELETION: 'Спочатку завершіть або перевірте видалення.',
  HISTORICAL_SYNC_UNRESOLVED: 'Спочатку перевірте незавершену доставку.',
  HISTORICAL_PRICE_INVALID: 'Чинна ціна потребує виправлення.',
  HISTORICAL_AUTO_DELIVERY_REQUIRED: 'Автоматична доставка ще не доступна.',
  HISTORICAL_BINDING_REQUIRED: 'Спочатку перевірте та застосуйте чинні правила категорії.',
  HISTORICAL_REMOTE_COUNTERPART_MISSING: 'Точний відповідник у Magento не знайдено. CREATE не виконуватиметься.',
  HISTORICAL_REMOTE_IDENTITY_MISMATCH: 'Magento ID або артикул не збігається з перевіркою.',
  HISTORICAL_REMOTE_STATUS_UNSUPPORTED: 'Поточний стан відповідника Magento потребує окремої перевірки.',
  HISTORICAL_DELIVERY_PLAN_BLOCKED: 'Поточні дані, назви або відповідності ще блокують UPDATE.',
  HISTORICAL_INTENT_EXISTS: 'Для товару вже є незавершене історичне рішення.',
  HISTORICAL_BUSINESS_EXCLUSION_REVIEW_REQUIRED: 'Є окреме бізнес-виключення. Воно потребує явної перевірки та не буде мовчки скасоване цим рішенням.',
});
export const historicalStateLabels = Object.freeze({
  queued: 'Нове рішення зареєстровано; безпечний UPDATE очікує виконання',
  delivering: 'Первісна доставка виконується або її результат перевіряється',
  cancelled: 'Рішення скасовано до початку доставки',
  dispatched: 'UPDATE надіслано; його результат ще перевіряється',
  blocked: 'Нове рішення зупинено — потрібна перевірка',
  awaiting_native: 'Приховування перевірено; підтвердження UPDATE ще очікується',
  completed: 'Обробку цього рішення завершено',
});
