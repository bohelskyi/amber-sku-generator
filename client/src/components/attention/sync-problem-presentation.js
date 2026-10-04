import { withRepairContext } from '../../lib/magento-repair-context.js';

export const PRODUCT_FIELD_LABELS = Object.freeze({
  name: 'Назва українською та англійською', rozmir_suveniriv: 'Розмір',
  kamin_obrobka: 'Обробка каменю', price: 'Ціна', weight: 'Вага',
  attribute_set_code: 'Набір характеристик', categories: 'Категорії Magento',
});

export function nextAction(problem = {}) {
  const code = problem.diagnosticCode || problem.code;
  if (problem.code === 'TEST_DELETION_PENDING') return 'Перевірити результат тестового видалення';
  if (problem.code === 'reconciliation_required') return 'Перевірити результат надісланої зміни';
  if (problem.resolution === 'lifecycle_reconciliation') return 'Перевірити історію доставки';
  if (problem.resolution === 'product') return 'Доповнити дані товару';
  if (problem.resolution === 'name') return 'Узгодити назви Amber і Magento';
  if (['authorization', 'configuration'].includes(problem.code)) return 'Перевірити підключення Magento';
  if (code === 'CATEGORY_PATH_MISSING') return 'Додати відсутню підкатегорію';
  if (['CATEGORY_PATH_AMBIGUOUS', 'CATEGORY_IDENTITIES_REVIEW_REQUIRED', 'CATEGORY_MAPPING_BLOCKED'].includes(code)) return 'Перевірити відповідність категорії';
  if (['OPTION_BINDING_REVIEW_REQUIRED', 'OPTION_MAPPING_REVIEW_REQUIRED', 'option_mapping_required'].includes(code)) return 'Пов’язати значення';
  if (['OPTION_UNRESOLVED', 'option_missing'].includes(code)) return 'Знайти або додати значення';
  if (['ATTRIBUTE_NOT_FOUND', 'ATTRIBUTE_METADATA_UNRESOLVED', 'attribute_missing'].includes(code)) return 'Налаштувати атрибут Magento';
  if (problem.resolution === 'integration_preparation') return 'Підготувати потрібну характеристику або категорію';
  if (problem.resolution === 'integration_configuration') return 'Перевірити правило або відповідність';
  return 'Переглянути збережені підтвердження';
}

export function problemSubject(problem = {}) {
  const target = problem.target || problem.field;
  return { path: problem.path || null,
    field: problem.fieldLabel || PRODUCT_FIELD_LABELS[target] || target || null,
    value: problem.expectedValue ?? problem.valueLabel ?? null };
}

export function problemTitle(problem = {}) {
  const subject = problemSubject(problem);
  const message = problem.evaluationIssues?.[0]?.message || problem.message || 'Причину ще не визначено';
  return subject.path ? `${subject.path} — ${message}` : subject.field && !problem.evaluationIssues?.length ? `${subject.field}: ${message}` : message;
}

export function problemRepairUrl(problem, product, returnTo) {
  const target = problem.target || problem.field;
  const placement = Boolean(problem.path) || target === 'categories' || (problem.diagnosticCode || problem.code || '').startsWith('CATEGORY_');
  return withRepairContext(product.category ? `/admin/magento/categories/${encodeURIComponent(product.category)}?tab=${placement ? 'placement' : 'attributes'}` : '/admin/magento', {
    productId: String(product.productId), category: product.category, field: target,
    question: problem.question || problem.questionKey, value: problem.value ?? problem.valueId,
    path: problem.path, returnTo,
  });
}

export function problemImpact(problem = {}) {
  if (problem.code === 'reconciliation_required') return 'Зміну вже надіслано. Поки результат не підтверджено, повторне надсилання заблоковане.';
  if (problem.code === 'TEST_DELETION_PENDING') return 'Результат видалення потрібно перевірити через початкову операцію товару.';
  if (problem.resolution === 'product') return 'Amber не може підготувати повні дані для Magento. Товар залишається збереженим в Amber.';
  if (problem.resolution === 'name') return 'Оновлення спільної назви потребує узгодження, щоб не перезаписати чужу зміну.';
  if (problem.resolution === 'lifecycle_reconciliation') return 'Доставку утримано до перевірки попередньої історії товару.';
  return 'Ця перешкода не дозволяє завершити синхронізацію цього товару.';
}
