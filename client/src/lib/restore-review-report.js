const shown = (value, absent = 'Не зафіксовано') => value === null || value === undefined || value === '' ? absent : String(value);

export function restoreReviewReport(items) {
  return ['Звіт перевірки відновлення товарів',
    'Це передавання на перевірку. Товари не відновлено, синхронізацію та видимість Magento не змінено.',
    ...items.filter((item) => item.disposition === 'conflict').flatMap((item) => [
      '', `Введений артикул: ${shown(item.inputSku)}`, `Артикул товару: ${shown(item.article)}`,
      `Товар №: ${shown(item.productId)}`, `Поточний стан: ${shown(item.status)}`, `Категорія: ${shown(item.category)}`,
      `Причина: ${shown(item.reasonCode)}`, `Попередній маршрут: ${shown(item.priorRoute)}`,
      `Попереднє виключення з експорту: ${shown(item.priorExclusion)}`,
      `Підтверджений Magento ID: ${shown(item.confirmedMagentoId, 'Не підтверджено')}`,
      'Потрібно перевірити причину архівування, попередній стан, історію переобліку та незавершені операції. Відсутні дані не означають дозвіл на відновлення.',
    ])].join('\n');
}

export function restoreReviewLinks(item) {
  if (!Number.isSafeInteger(item.productId) || item.productId <= 0 || !item.article) return null;
  const article = encodeURIComponent(item.article);
  return { product: `/products/open?article=${article}`, history: `/products/history?sku=${article}` };
}
