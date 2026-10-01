export const workspaceNavigation = [
  { to: '/', label: 'Товари', end: true, group: 'Робота', primary: true, permissions: ['products.view'] },
  { to: '/admin/repricing', label: 'Переоцінка', group: 'Робота', primary: true, permissions: ['repricing.view'] },
  { to: '/sync-problems', label: 'Проблеми синхронізації', group: 'Робота', primary: true, permissions: ['products.view'] },
  { to: '/settings', label: 'Налаштування', group: 'Налаштування', primary: true,
    permissions: ['catalog.view', 'pricing.view', 'users.manage', 'roles.manage', 'audit.view', 'history.view'] },
  { to: '/exports', label: 'Експорт', group: 'Сумісність', permissions: ['exports.view'] },
  { to: '/admin/corrections', label: 'Запити на виправлення', end: true, group: 'Робота', permissions: ['corrections.view'] },
  { to: '/admin/corrections/history', label: 'Історія товарів', group: 'Робота', permissions: ['history.view'] },
  { to: '/admin', label: 'Каталог і ціни', end: true, group: 'Налаштування', permissions: ['catalog.view', 'pricing.view'] },
  { to: '/admin/export-templates', label: 'Шаблони експорту', group: 'Налаштування', permissions: ['export_templates.view'] },
  { to: '/admin/users', label: 'Користувачі', group: 'Адміністрування', permissions: ['users.manage'] },
  { to: '/admin/roles', label: 'Ролі', group: 'Адміністрування', permissions: ['roles.manage'] },
  { to: '/admin/audit', label: 'Аудит', group: 'Адміністрування', permissions: ['audit.view'] },
];

export function dailyWorkspaceNavigation(permissions = []) {
  return allowedWorkspaceNavigation(permissions).filter((item) => item.primary
    || (item.to === '/admin/corrections' && !permissions.includes('products.recount')
      && permissions.includes('corrections.create')));
}

export function allowedWorkspaceNavigation(permissions = []) {
  return workspaceNavigation.filter((item) => item.permissions.some((key) => permissions.includes(key)));
}

export function isWorkspaceDestination(item, pathname) {
  return pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`));
}
