export const USER_ROLE_LABELS = Object.freeze({
  administrator: 'Адміністратор',
  manager: 'Керівник',
  storekeeper: 'Комірниця',
});

export const APPLICATION_USER_STATUS_LABELS = Object.freeze({
  pending: 'Очікує підтвердження',
  active: 'Активний',
  disabled: 'Доступ вимкнено',
});

export function getUserRoleLabel(roleKey) {
  return USER_ROLE_LABELS[roleKey] || 'Роль не призначена';
}

export function getApplicationUserStatusLabel(status) {
  return APPLICATION_USER_STATUS_LABELS[status] || 'Невідомий стан';
}

export function getUserManagementErrorMessage(error) {
  if (error?.response?.data?.code === 'LAST_ADMINISTRATOR_REQUIRED') {
    return 'У системі має залишитися щонайменше один активний Адміністратор.';
  }
  if (error?.response?.status === 403) {
    return 'Недостатньо прав для керування користувачами.';
  }
  return 'Не вдалося оновити доступ користувача. Спробуйте ще раз.';
}
