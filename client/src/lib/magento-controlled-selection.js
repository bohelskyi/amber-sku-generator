export const CONTROLLED_SELECTION_LIMIT = 100;

export const controlledBlockerLabels = Object.freeze({
  DUPLICATE_SKU_INPUT: 'Цей артикул повторено у списку; товар додається лише один раз.',
  RECONCILIATION_REQUIRED: 'Раніше надіслану зміну ще не підтверджено. Спочатку перевірте початкову операцію.',
  NAME_CONFLICT_OR_BASELINE_REQUIRED: 'Спочатку узгодьте поточні назви Amber і Magento.',
  INVALID_GENERATED_NAMES: 'Правило не формує дві допустимі назви.',
  PRODUCT_NOT_CURRENT_OR_EXCLUDED: 'Товар неактивний, замінений або виключений із доставки.',
  PRODUCT_NOT_UNIQUE: 'Артикул пов’язаний із кількома локальними товарами. Потрібна перевірка ідентичності.',
  CATEGORY_SCOPE_MISMATCH: 'Товар належить до іншої категорії, ніж вибрана для цієї дії.',
});
export const controlledBlockerText = (code) => controlledBlockerLabels[code] || `Перевірка зупинена: ${code}. Передайте точний код відповідальному за інтеграцію.`;

export function selectableControlledProduct(product, kind) {
  return !product.blockers.some((code) => ['RECONCILIATION_REQUIRED', 'PRODUCT_NOT_CURRENT_OR_EXCLUDED', 'PRODUCT_NOT_UNIQUE', 'CATEGORY_SCOPE_MISMATCH'].includes(code))
    && (kind !== 'name_rule' || product.changed && product.blockers.length === 0);
}

export function exactSkuInput(text) {
  if (text.length > 20000) return { skus: [], error: 'Список задовгий. Скоротіть його до 100 точних артикулів; введення не обрізано.' };
  const skus = text.split(/[\r\n\t]+/).map((sku) => sku.trim()).filter(Boolean);
  if (!skus.length) return { skus, error: 'Вставте хоча б один точний артикул.' };
  if (skus.length > CONTROLLED_SELECTION_LIMIT) return { skus, error: 'За одну перевірку можна вставити щонайбільше 100 артикулів, включно з повторами.' };
  if (skus.some((sku) => sku.length > 100 || [...sku].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127))) return { skus, error: 'Кожен артикул має містити до 100 символів без керівних символів.' };
  return { skus, error: '' };
}

export function checkedExactSkuResponse(data, skus) {
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.results) || data.nextCursor !== null
    || data.results.length !== skus.length) throw new Error('Неповна відповідь перевірки точних артикулів. Вибір не змінено.');
  const ids = new Set(); const bySku = new Map();
  for (const product of data.products) {
    if (!Number.isSafeInteger(product?.productId) || product.productId <= 0 || ids.has(product.productId)
      || typeof product.article !== 'string' || !skus.includes(product.article) || bySku.has(product.article)
      || !Array.isArray(product.blockers) || product.blockers.some((code) => typeof code !== 'string')
      || !product.before || !product.after || typeof product.changed !== 'boolean') throw new Error('Недостовірний товар у перевірці точних артикулів. Вибір не змінено.');
    ids.add(product.productId); bySku.set(product.article, product);
  }
  const seen = new Set();
  for (const [index, result] of data.results.entries()) {
    if (result?.sku !== skus[index] || !['eligible', 'blocked', 'missing', 'duplicate'].includes(result.state)
      || !Array.isArray(result.blockers) || result.blockers.some((code) => typeof code !== 'string')
      || (result.productId !== undefined && (!Number.isSafeInteger(result.productId) || result.productId <= 0))) throw new Error('Недостовірний результат перевірки артикулів. Вибір не змінено.');
    if (seen.has(result.sku) !== (result.state === 'duplicate')) throw new Error('Непідтверджений повтор артикулу. Вибір не змінено.');
    if (result.state === 'eligible' && result.blockers.some((code) => ['RECONCILIATION_REQUIRED', 'PRODUCT_NOT_CURRENT_OR_EXCLUDED', 'PRODUCT_NOT_UNIQUE', 'CATEGORY_SCOPE_MISMATCH'].includes(code))) throw new Error('Суперечлива доступність товару. Вибір не змінено.');
    if (result.state === 'eligible' && (!bySku.has(result.sku) || bySku.get(result.sku).productId !== result.productId)) throw new Error('Ідентичність товару не підтверджена. Вибір не змінено.');
    if (result.state === 'missing' && result.productId !== undefined) throw new Error('Суперечливий результат перевірки. Вибір не змінено.');
    seen.add(result.sku);
  }
  if (data.products.some((product) => !data.results.some((result) => ['eligible', 'blocked'].includes(result.state) && result.sku === product.article && result.productId === product.productId))) throw new Error('Зайвий товар у перевірці артикулів. Вибір не змінено.');
  return data;
}
