const EDIT_ACTIONS = new Set(['new-category', 'new-question', 'new-option', 'edit-question', 'edit-option']);

export function getCatalogReturnTarget(value) {
  if (typeof value !== 'string' || value.length > 3000 || !value.startsWith('/')
      || /[\\#]/.test(value) || [...value].some((character) => character.charCodeAt(0) < 32)) return null;
  try {
    const url = new URL(value, 'https://manager.local');
    if (url.origin !== 'https://manager.local') return null;
    const rawPath = value.split('?')[0];
    if (rawPath !== url.pathname) return null;
    if (url.pathname !== '/attention' && url.pathname !== '/admin/magento/prepare' && !/^\/admin\/magento\/categories\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname)) return null;
    return value;
  } catch { return null; }
}

export function resolveCatalogEntry(config, search, key) {
  const params = new URLSearchParams(search);
  const requestedCategory = params.get('category');
  const requestedQuestion = params.get('question');
  const action = params.get('action');
  const category = config?.categories?.[requestedCategory] || null;
  const questions = category ? config?.questions?.[category.code] || [] : [];
  const question = questions.find((item) => item.id === requestedQuestion)
    || questions.find((item) => requestedQuestion !== null && String(item.q_db_id) === requestedQuestion) || null;
  const value = params.get('value');
  const optionDbId = params.get('optionId');
  const options = question && value !== null && /^(?:0|[1-9]\d*)$/.test(value)
    ? (question.options || []).filter((item) => String(item.id) === value
      && (optionDbId === null || String(item.db_id) === optionDbId)) : [];
  // Contextual aliases share a semantic ID; a link must resolve one exact row.
  const option = options.length === 1 && options[0].db_id != null ? options[0] : null;
  const valid = EDIT_ACTIONS.has(action) && (action === 'new-category' || (category
    && (!['new-option', 'edit-question', 'edit-option'].includes(action) || question)
    && (action !== 'edit-option' || option)));
  return { category, question, option, requestedCategory, returnTo: getCatalogReturnTarget(params.get('returnTo')),
    action: valid ? { key, action, category: category?.code, question: question?.id,
      questionDbId: question?.q_db_id, optionDbId: option?.db_id } : null,
    invalidTarget: EDIT_ACTIONS.has(action) && !valid };
}
