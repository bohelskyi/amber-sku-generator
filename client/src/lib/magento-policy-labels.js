// Display text only: the server owns policy eligibility and review decisions.
export const deliveryPolicies = Object.freeze({
  authoritative_create_update: 'Оновлюється з менеджера',
  initialize_create_only: 'Лише під час створення',
  magento_managed: 'Зберігати значення Magento',
});

export const deliveryPolicyLabel = (policy) => Object.hasOwn(deliveryPolicies, policy) ? deliveryPolicies[policy] : undefined;

export const deliveryPolicyEffects = Object.freeze({
  authoritative_create_update: 'Для чинних товарів наступна підтверджена синхронізація оновить це поле з менеджера.',
  initialize_create_only: 'Для чинних товарів це поле залишається без змін. Менеджер заповнює його тільки під час створення в Magento.',
  magento_managed: 'Менеджер не змінює це поле в Magento. Підтримуйте його вручну в магазині.',
});

export function deliveryPolicyEffect(policy, target) {
  return target === 'name' && policy === 'authoritative_create_update'
    ? 'Нове правило формує назви нових товарів. Збережені назви чинних товарів залишаються закріпленими; їх застосування потребує окремого підтвердження Адміністратора.'
    : Object.hasOwn(deliveryPolicyEffects, policy) ? deliveryPolicyEffects[policy] : undefined;
}

export const disabledProductInitializationHint = ' · вимкнений товар';
export const ruleApplyLabels = Object.freeze({ apply: 'Застосувати правила', applying: 'Застосовуємо правила…' });
