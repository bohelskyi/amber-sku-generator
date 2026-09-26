// Display states only: never used to authorize a command or construct its identity.
export function sessionDisplayState(session, { dirty = false, conflict = false, stale = false, preview,
  tableAvailable = false, preparationMatches = false, uncertain = false } = {}) {
  const snapshot = session.snapshot;
  if (snapshot?.status === 'confirmed') return 'Завершено';
  if (snapshot?.status === 'generated' || session.snapshotId) return 'Файли створено';
  if (conflict) return 'Потрібна увага';
  if (dirty) return 'Чернетка';
  // A held lock alone may belong to a settings/membership command. Lists do not
  // reconcile locks, so an executing marker there asks the operator to open it.
  if (session.attempt?.state === 'executing' && session.executing === true) return 'Створюються файли';
  if (uncertain || ['failed', 'interrupted', 'executing'].includes(session.attempt?.state)) return 'Потрібна увага';
  if (stale || !tableAvailable) return 'Потрібна перевірка';
  if (!preview?.representedCount || preview.errors?.length) return 'Потрібна увага';
  if (session.attempt?.state === 'prepared' && preparationMatches) return 'Готовий до створення файлів';
  return 'Перевірено · перевірку не збережено';
}

export const rangeText = (range) => !range ? 'Немає даних' : range.mode === 'new' ? 'Нові товари'
  : !range.fromSku ? 'Немає даних' : range.fromSku === (range.toSku || range.resolvedToSku) ? range.fromSku
    : `${range.fromSku} — ${range.toSku || range.resolvedToSku || 'до останнього товару'}`;
export const sessionRecipe = (session) => {
  const result = session.snapshot;
  const template = result?.templateLabel || session.template || session.attempt?.preview?.template;
  if (template) return `${template.displayName || 'Опублікований шаблон'} · v${template.versionNumber || 'Немає даних'}`;
  return result?.recipe?.name || 'Опублікований шаблон · визначиться під час перевірки';
};
export const participantCount = (session) => session.participantCount ?? 1 + (session.participants || []).filter((m) => m.state === 'accepted').length;
