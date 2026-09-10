export const AUDIT_DOMAINS = Object.freeze([
  ['application_user', 'Користувачі'],
  ['role', 'Ролі та права'],
  ['catalog', 'Каталог'],
  ['pricing', 'Ціноутворення'],
  ['product', 'Товари'],
  ['correction_request', 'Запити на виправлення'],
  ['repricing', 'Переоцінка'],
  ['repricing_draft', 'Чернетки переоцінки'],
  ['export_snapshot', 'Експорти'],
  ['sku_schema', 'Схеми SKU'],
]);

const EVENT_LABELS = Object.freeze({
  'application_user.approved': 'Користувачу надано доступ',
  'application_user.role_changed': 'Роль користувача змінено',
  'application_user.disabled': 'Доступ користувача вимкнено',
  'application_user.enabled': 'Доступ користувача увімкнено',
  'role.created': 'Роль створено',
  'role.updated': 'Роль змінено',
  'role.permissions_changed': 'Права ролі змінено',
  'role.deactivated': 'Роль деактивовано',
  'role.reactivated': 'Роль активовано',
  'catalog.category.created': 'Категорію створено',
  'catalog.category.updated': 'Категорію змінено',
  'catalog.category.deleted': 'Категорію видалено',
  'catalog.question.created': 'Характеристику створено',
  'catalog.question.updated': 'Характеристику змінено',
  'catalog.question.reordered': 'Порядок характеристик змінено',
  'catalog.question.deleted': 'Характеристику видалено',
  'catalog.option.created': 'Варіант відповіді створено',
  'catalog.option.updated': 'Варіант відповіді змінено',
  'catalog.option.archived': 'Варіант відповіді архівовано',
  'catalog.option.unarchived': 'Варіант відповіді відновлено',
  'catalog.option.deleted': 'Варіант відповіді видалено',
  'pricing.scenario.created': 'Ціновий сценарій створено',
  'pricing.scenario.updated': 'Ціновий сценарій змінено',
  'pricing.scenario.duplicated': 'Ціновий сценарій скопійовано',
  'pricing.scenario.deleted': 'Ціновий сценарій видалено',
  'pricing.matrix_cell.set': 'Ціну в матриці встановлено',
  'pricing.matrix_cell.deleted': 'Ціну з матриці видалено',
  'pricing.modifier.created': 'Модифікатор ціни створено',
  'pricing.modifier.updated': 'Модифікатор ціни змінено',
  'pricing.modifier.deleted': 'Модифікатор ціни видалено',
  'product.created': 'Товар створено',
  'product.recounted': 'Товар перераховано',
  'product.archived': 'Товар архівовано',
  'correction_request.created': 'Запит на виправлення створено',
  'correction_request.claimed': 'Запит взято в роботу',
  'correction_request.released': 'Запит повернуто в чергу',
  'correction_request.force_released': 'Запит примусово повернуто в чергу',
  'correction_request.rejected': 'Запит відхилено',
  'correction_request.reopened': 'Запит відкрито повторно',
  'correction_request.completed': 'Запит виконано',
  'repricing_draft.created': 'Чернетку переоцінки створено',
  'repricing_draft.discarded': 'Чернетку переоцінки відкинуто',
  'repricing.applied': 'Переоцінку застосовано',
  'repricing.rolled_back': 'Переоцінку відкочено',
  'export_snapshot.created': 'Експорт створено',
  'export_snapshot.confirmed': 'Експорт підтверджено',
  'sku_schema.published': 'Схему SKU опубліковано',
});

const SUBJECT_LABELS = Object.freeze({
  application_user: 'Користувач', role: 'Роль', catalog_category: 'Категорія',
  catalog_question: 'Характеристика', catalog_option: 'Варіант відповіді',
  pricing_scenario: 'Ціновий сценарій', pricing_matrix_cell: 'Комірка матриці',
  pricing_modifier: 'Модифікатор ціни', product: 'Товар',
  correction_request: 'Запит на виправлення', repricing_draft: 'Чернетка переоцінки',
  repricing_batch: 'Пакет переоцінки', export_snapshot: 'Експорт',
  sku_schema_version: 'Версія схеми SKU',
});

const DETAIL_LABELS = Object.freeze({
  addedPermissionKeys: 'Додані права', affectedActiveUserCount: 'Активних користувачів',
  affectedCounts: 'Пов’язані записи', affectedDisabledUserCount: 'Вимкнених користувачів',
  axisXKey: 'Вісь X', axisYKey: 'Вісь Y', categoryCode: 'Категорія',
  changedCount: 'Кількість змін', changedFields: 'Змінені поля',
  changedQuestionIds: 'Характеристики', changes: 'Зміни', code: 'Код',
  correctedSku: 'Новий SKU', displayName: 'Назва', exportedToProductId: 'Останній товар експорту',
  factor: 'Коефіцієнт', fromSku: 'Від SKU', fullSku: 'SKU', groupName: 'Група', key: 'Ключ',
  label: 'Назва', name: 'Назва', newDisplayName: 'Нова назва', newPrice: 'Нова ціна',
  newRole: 'Нова роль', newStatus: 'Новий стан', oldPrice: 'Попередня ціна',
  permissionKeys: 'Права', previousCode: 'Попередній код',
  previousDisplayName: 'Попередня назва', previousOwnerUserId: 'Попередній виконавець',
  previousRole: 'Попередня роль', previousStatus: 'Попередній стан', priceMode: 'Режим ціни',
  proposedSku: 'Запропонований SKU', questionId: 'Характеристика', questionKey: 'Ключ характеристики',
  reason: 'Причина', removedPermissionKeys: 'Вилучені права', requiresWeight: 'Потрібна вага',
  role: 'Роль', roleKey: 'Ключ ролі', rowCount: 'Рядків', scenarioId: 'Ціновий сценарій',
  scenarioName: 'Ціновий сценарій', scope: 'Обсяг', skipHiddenSkuQuestions: 'Пропуск прихованих полів SKU',
  skuCode: 'Код SKU', sourceScenarioId: 'Вихідний сценарій', sourceSku: 'Початковий SKU',
  status: 'Стан', toSku: 'До SKU', triggerKey: 'Умова', triggerValue: 'Значення умови',
  userStatus: 'Стан користувача', valueId: 'Значення', version: 'Версія',
  versionFrom: 'Версія до', versionTo: 'Версія після', weightBandChanges: 'Зміни діапазонів ваги',
  weightBandCount: 'Діапазонів ваги', xValue: 'Значення X', yValue: 'Значення Y',
});

export function getAuditEventLabel(eventKey) {
  return EVENT_LABELS[eventKey] || `Подія: ${eventKey || 'невідомий ключ'}`;
}

export function getAuditSubjectLabel(subject = {}) {
  return `${SUBJECT_LABELS[subject.type] || subject.type || 'Об’єкт'} · ${subject.id || 'не записано'}`;
}

export function getAuditActorLabel(actor = {}) {
  if (actor.status === 'not_recorded') return 'Виконавець не записаний';
  if (actor.status === 'recorded_reference') return `Користувач #${actor.id} · ім’я не записано`;
  return actor.displayName || actor.preferredUsername || `Користувач #${actor.id}`;
}

export function getAuditDetailLabel(key) {
  return DETAIL_LABELS[key] || key;
}

export function formatAuditDetailValue(value) {
  if (value === null || value === undefined || value === '') return 'не записано';
  if (typeof value === 'boolean') return value ? 'так' : 'ні';
  if (Array.isArray(value)) return value.length
    ? value.map((item) => formatAuditDetailValue(item)).join(', ')
    : 'немає';
  if (typeof value === 'object') return Object.entries(value)
    .map(([key, item]) => `${getAuditDetailLabel(key)}: ${formatAuditDetailValue(item)}`)
    .join('; ');
  return String(value);
}
