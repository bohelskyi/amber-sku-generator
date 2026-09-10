export const APPLICATION_USER_STATUS_LABELS = Object.freeze({
  pending: 'Очікує підтвердження',
  active: 'Активний',
  disabled: 'Доступ вимкнено',
});

export function getUserRoleLabel(role) {
  return role?.displayName || 'Роль не призначена';
}

export function getApplicationUserStatusLabel(status) {
  return APPLICATION_USER_STATUS_LABELS[status] || 'Невідомий стан';
}

export function getUserManagementErrorMessage(error) {
  if (error?.response?.data?.code === 'LAST_ADMINISTRATOR_REQUIRED') {
    return 'У системі має залишитися щонайменше один активний Адміністратор.';
  }
  if (error?.response?.data?.code === 'APPLICATION_USER_ASSIGNMENT_CONFLICT') {
    return 'Роль користувача вже змінилася. Оновіть список і спробуйте ще раз.';
  }
  if (error?.response?.data?.code === 'ROLE_NOT_ASSIGNABLE') {
    return 'Обрана роль більше недоступна для призначення.';
  }
  if (error?.response?.status === 403) {
    return 'Недостатньо прав для керування користувачами.';
  }
  return 'Не вдалося оновити доступ користувача. Спробуйте ще раз.';
}
