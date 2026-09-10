export const PERMISSION_DOMAINS = Object.freeze([
  { key: 'products', label: 'Товари та історія' },
  { key: 'corrections', label: 'Виправлення' },
  { key: 'repricing', label: 'Переоцінка' },
  { key: 'exports', label: 'Експорт' },
  { key: 'catalog', label: 'Каталог і ціни' },
  { key: 'access', label: 'Адміністрування доступу' },
]);

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
