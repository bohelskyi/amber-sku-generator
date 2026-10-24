import { expect, it } from 'vitest';
import { deliveryPolicies, deliveryPolicyLabel, deliveryPolicyEffects, deliveryPolicyEffect, disabledProductInitializationHint, ruleApplyLabels } from '../src/lib/magento-policy-labels.js';
import * as workspace from '../src/lib/magento-category-workspace.js';

it('keeps the three saved policy enums and canonical Ukrainian labels in their existing order', () => {
  expect(Object.entries(deliveryPolicies)).toEqual([
    ['authoritative_create_update', 'Оновлюється з менеджера'],
    ['initialize_create_only', 'Лише під час створення'],
    ['magento_managed', 'Зберігати значення Magento'],
  ]);
  expect(Object.keys(deliveryPolicies).map(deliveryPolicyLabel)).toEqual([
    'Оновлюється з менеджера', 'Лише під час створення', 'Зберігати значення Magento',
  ]);
  for (const unknown of ['future_policy', 'toString', 'constructor', undefined, null, 'preserve_by_safe_preview']) {
    expect(deliveryPolicyLabel(unknown)).toBeUndefined();
    expect(deliveryPolicyEffect(unknown, 'name')).toBeUndefined();
  }
  expect(ruleApplyLabels).toEqual({ apply: 'Застосувати правила', applying: 'Застосовуємо правила…' });
  expect(disabledProductInitializationHint).toBe(' · вимкнений товар');
});

it('preserves existing-product effects and the separate Administrator decision for saved names', () => {
  expect(deliveryPolicyEffect('authoritative_create_update', 'price')).toBe('Для чинних товарів наступна підтверджена синхронізація оновить це поле з менеджера.');
  expect(deliveryPolicyEffect('initialize_create_only', 'name')).toBe('Для чинних товарів це поле залишається без змін. Менеджер заповнює його тільки під час створення в Magento.');
  expect(deliveryPolicyEffect('magento_managed', 'name')).toBe('Менеджер не змінює це поле в Magento. Підтримуйте його вручну в магазині.');
  expect(deliveryPolicyEffect('authoritative_create_update', 'name')).toBe('Нове правило формує назви нових товарів. Збережені назви чинних товарів залишаються закріпленими; їх застосування потребує окремого підтвердження Адміністратора.');
  expect(deliveryPolicyEffect('unknown', 'name')).toBeUndefined();
});

it('retains the existing workspace exports as the same shared presenter', () => {
  expect(workspace.deliveryPolicies).toBe(deliveryPolicies);
  expect(workspace.deliveryPolicyEffects).toBe(deliveryPolicyEffects);
  expect(workspace.deliveryPolicyEffect).toBe(deliveryPolicyEffect);
});
