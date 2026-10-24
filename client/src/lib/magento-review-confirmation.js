const messages = {
  saved: 'Це рішення вже збережено. Повторне підтвердження не потрібне.',
  policy: 'Оберіть поведінку поля.',
  mapping: 'Оберіть відповідність Magento.',
  missing_mapping: 'Відповідність Magento ще не визначена. Перевірте налаштування поля.',
  candidate: 'Оберіть кандидата й натисніть «Вибрати кандидата».',
  reason_three: 'Додайте пояснення перевірки — щонайменше 3 символи.',
  reason: 'Додайте пояснення перевірки.',
  access: 'Підтвердження недоступне для вашого поточного доступу.',
  retired: 'Підготовка посилається на видалені ресурси Magento. Підготуйте нову від чинної публікації.',
  stale: 'Чинні правила змінилися. Потрібна нова перевірка підготовки.',
};

// Presentation only: callers retain their distinct existing approval predicates.
export function confirmationHint({ busy, externalDisabled, externalReason, reasonCode, count }) {
  if (busy) return 'Дія виконується. Дочекайтеся результату.';
  if (externalDisabled) return externalReason || 'Підтвердження тимчасово недоступне.';
  if (reasonCode === 'rows') return `Не готові до підтвердження рядки: ${count}. Виконайте підказки біля їхніх кнопок.`;
  return Object.hasOwn(messages, reasonCode) ? messages[reasonCode] : '';
}
