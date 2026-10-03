export const topLevelNavigation = [
  {
    id: 'products', to: '/products', label: 'Товари', group: 'Щоденна робота',
    permissions: ['products.view', 'products.decode', 'history.view'],
    activePaths: [{ path: '/products' }, { path: '/admin/corrections/history', end: true }],
  },
  {
    id: 'attention', to: '/attention', label: 'Потребує уваги', group: 'Щоденна робота',
    permissions: ['corrections.view', 'products.view'],
    activePaths: [{ path: '/attention' }, { path: '/admin/corrections', end: true }, { path: '/sync-problems' }],
  },
  {
    id: 'repricing', to: '/admin/repricing', label: 'Переоцінка', group: 'Щоденна робота',
    permissions: ['repricing.view'], activePaths: [{ path: '/admin/repricing' }],
  },
  {
    id: 'settings', to: '/settings', label: 'Налаштування', group: 'Система',
    permissions: ['catalog.view', 'pricing.view', 'export_templates.view'],
    activePaths: [
      { path: '/settings' }, { path: '/admin', end: true }, { path: '/admin/catalog' }, { path: '/admin/pricing' },
      { path: '/admin/magento' }, { path: '/admin/export-templates' },
    ],
  },
  {
    id: 'administration', to: '/administration', label: 'Адміністрування', group: 'Система',
    permissions: ['users.manage', 'roles.manage', 'audit.view'],
    activePaths: [{ path: '/administration' }, { path: '/admin/users' }, { path: '/admin/roles' }, { path: '/admin/audit' }],
  },
];

export const settingsNavigation = [
  { to: '/admin/catalog', label: 'Каталог', description: 'Категорії, характеристики та схеми внутрішнього SKU.', permissions: ['catalog.view'] },
  { to: '/admin/pricing', label: 'Ціноутворення', description: 'Матриці, модифікатори та курси для розрахунку.', permissions: ['pricing.view'] },
  { to: '/admin/magento', label: 'Інтеграція Magento', description: 'Доставка товарів, відповідності та підготовка публікацій.', permissions: ['export_templates.view'] },
  { to: '/admin/export-templates', label: 'Шаблони інтеграції', description: 'Правила даних, опубліковані версії яких використовують відповідності та пряма синхронізація Magento.', permissions: ['export_templates.view'] },
];

export const administrationNavigation = [
  { to: '/admin/users', label: 'Користувачі', description: 'Доступ користувачів і призначення ролей.', permissions: ['users.manage'] },
  { to: '/admin/roles', label: 'Ролі та дозволи', description: 'Набори дозволів для робочих обов’язків.', permissions: ['roles.manage'] },
  { to: '/admin/audit', label: 'Аудит', description: 'Історія контрольованих дій у системі.', permissions: ['audit.view'] },
];

// Account-menu access only; these compatibility routes are not daily destinations.
export const legacyNavigation = [
  { id: 'legacy-exports', to: '/exports', label: 'Історичний експорт', permissions: ['exports.view'], activePaths: [{ path: '/exports' }] },
];

const secondaryNavigation = [
  { to: '/admin/corrections', label: 'Запити на виправлення', end: true, permissions: ['corrections.view'] },
  { to: '/sync-problems', label: 'Проблеми синхронізації', permissions: ['products.view'] },
  { to: '/admin/corrections/history', label: 'Історія товарів', permissions: ['history.view'] },
];

export const workspaceNavigation = [...topLevelNavigation, ...settingsNavigation, ...administrationNavigation, ...secondaryNavigation, ...legacyNavigation];

export function hasAnyPermission(permissions = [], required = []) {
  return required.some((key) => permissions.includes(key));
}

export function hasAllPermissions(permissions = [], required = []) {
  return required.every((key) => permissions.includes(key));
}

export function navigationForPermissions(items, permissions = []) {
  return items.filter((item) => hasAnyPermission(permissions, item.permissions));
}

export function dailyWorkspaceNavigation(permissions = []) {
  return navigationForPermissions(topLevelNavigation, permissions);
}

export function allowedWorkspaceNavigation(permissions = []) {
  return navigationForPermissions(workspaceNavigation, permissions);
}

function matchesPath(definition, pathname) {
  const { path, end = false } = typeof definition === 'string' ? { path: definition } : definition;
  return pathname === path || (!end && pathname.startsWith(`${path}/`));
}

export function isWorkspaceDestination(item, pathname) {
  const paths = item.activePaths || [{ path: item.to, end: item.end }];
  return paths.some((path) => matchesPath(path, pathname));
}

export function activeWorkspaceDestination(permissions = [], pathname = '/') {
  return dailyWorkspaceNavigation(permissions).find((item) => isWorkspaceDestination(item, pathname))
    || navigationForPermissions(legacyNavigation, permissions).find((item) => isWorkspaceDestination(item, pathname)) || null;
}
