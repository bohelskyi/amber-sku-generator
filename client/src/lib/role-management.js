export const PERMISSION_DOMAINS = Object.freeze([
  { key: 'products', label: 'Товари та історія', description: 'Створення, пошук і життєвий цикл товарів.' },
  { key: 'corrections', label: 'Виправлення', description: 'Запити, їх опрацювання та контроль власності.' },
  { key: 'repricing', label: 'Переоцінка', description: 'Підготовка, застосування та відкат нових цін.' },
  { key: 'exports', label: 'Експорт', description: 'Перегляд і створення незмінних CSV-знімків.' },
  { key: 'catalog', label: 'Каталог і ціни', description: 'Структура SKU, матриці та правила ціноутворення.' },
  { key: 'access', label: 'Адміністрування доступу', description: 'Користувачі, ролі та журнал аудиту.' },
]);

export const PERMISSION_PRESENTATION = Object.freeze({
  'products.view': ['Перегляд товарів', 'Перегляд списку та основних даних товарів.'],
  'products.decode': ['Розшифрування SKU', 'Пошук і розшифрування збережених артикулів.'],
  'products.create': ['Створення товарів', 'Формування та збереження нових товарів.'],
  'products.archive': ['Архівування товарів', 'Вилучення товарів з активного обігу та експорту.'],
  'products.recount': ['Прямий переоблік', 'Застосування виправлення товару без черги запитів.'],
  'history.view': ['Історія товару', 'Перегляд журналу змін і ланцюжка SKU.'],
  'corrections.view': ['Перегляд запитів', 'Перегляд черги та станів запитів на виправлення.'],
  'corrections.create': ['Створення запитів', 'Підготовка й надсилання запитів на виправлення.'],
  'corrections.claim': ['Опрацювання запитів', 'Взяття запиту в роботу та повернення в чергу.'],
  'corrections.complete': ['Завершення виправлень', 'Оновлення пропозиції та завершення власного запиту.'],
  'corrections.reject': ['Відхилення та повторне відкриття', 'Керування відхиленими запитами.'],
  'corrections.force_release': ['Примусове звільнення', 'Повернення чужого запиту в чергу з підтвердженням.'],
  'repricing.view': ['Перегляд переоцінки', 'Перегляд сценаріїв, чернеток і завершених партій.'],
  'repricing.prepare': ['Підготовка переоцінки', 'Створення та редагування чернеток і рішень.'],
  'repricing.apply': ['Застосування переоцінки', 'Атомарне застосування підготовлених змін цін.'],
  'repricing.rollback': ['Відкат переоцінки', 'Відновлення цін із завершеної партії.'],
  'exports.view': ['Перегляд експорту', 'Перегляд стану та завантаження готових знімків.'],
  'exports.create': ['Створення експорту', 'Створення і підтвердження CSV-знімків.'],
  'catalog.view': ['Перегляд каталогу', 'Перегляд структури категорій, питань і варіантів.'],
  'catalog.manage': ['Редагування каталогу', 'Зміна чернетки структури каталогу.'],
  'sku_schemas.publish': ['Публікація схеми SKU', 'Публікація нової незмінної версії схеми.'],
  'pricing.view': ['Перегляд цін', 'Перегляд матриць, сценаріїв і модифікаторів.'],
  'pricing.manage': ['Редагування цін', 'Зміна матриць, сценаріїв і модифікаторів.'],
  'users.manage': ['Керування користувачами', 'Підтвердження доступу, статусів і призначених ролей.'],
  'roles.manage': ['Керування ролями', 'Створення ролей та зміна наборів дозволів.'],
  'audit.view': ['Перегляд глобального аудиту', 'Перегляд незмінного журналу безпеки та бізнес-дій.'],
});

export function getPermissionPresentation(permission) {
  const [label, description] = PERMISSION_PRESENTATION[permission.key] || [
    permission.key,
    permission.description || 'Додатковий дозвіл застосунку.',
  ];
  return { label, description };
}

export function getPermissionDomain(permissionKey) {
  if (permissionKey === 'history.view' || permissionKey.startsWith('products.')) {
    return 'products';
  }
  if (permissionKey.startsWith('corrections.')) return 'corrections';
  if (permissionKey.startsWith('repricing.')) return 'repricing';
  if (permissionKey.startsWith('exports.')) return 'exports';
  if (
    permissionKey.startsWith('catalog.')
    || permissionKey.startsWith('pricing.')
    || permissionKey.startsWith('sku_schemas.')
  ) return 'catalog';
  return 'access';
}

export function groupPermissions(permissions = []) {
  return PERMISSION_DOMAINS.map((domain) => ({
    ...domain,
    permissions: permissions.filter((permission) => (
      getPermissionDomain(permission.key) === domain.key
    )),
  })).filter((domain) => domain.permissions.length > 0);
}

export function getRoleManagementErrorMessage(error) {
  const code = error?.response?.data?.code;
  const messages = {
    ADMINISTRATOR_ROLE_PROTECTED: 'Роль Адміністратора захищена від змін.',
    RESERVED_PERMISSION: 'Ці дозволи може мати лише Адміністратор.',
    ROLE_AFFECTED_USERS_CONFLICT: 'Кількість зачеплених користувачів змінилася. Перевірте роль ще раз.',
    ROLE_DISPLAY_NAME_CONFLICT: 'Роль з такою назвою вже існує.',
    ROLE_HAS_CURRENT_ASSIGNMENTS: 'Спочатку призначте інші ролі всім активним і вимкненим користувачам.',
    ROLE_VERSION_CONFLICT: 'Роль вже змінилася. Оновіть дані та спробуйте ще раз.',
  };
  if (messages[code]) return messages[code];
  if (error?.response?.status === 403) {
    return 'Недостатньо прав для керування ролями.';
  }
  return 'Не вдалося оновити роль. Спробуйте ще раз.';
}
