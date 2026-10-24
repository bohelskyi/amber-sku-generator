import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { IntegrationRulesTable } from '../src/components/export-templates/IntegrationRulesTable.jsx';
import { DefinitionEditor } from '../src/components/export-templates/DefinitionEditor.jsx';
import { sourceLabel } from '../src/lib/export-template-presentation.js';
import * as policyLabels from '../src/lib/magento-policy-labels.js';

afterEach(cleanup);
const definition = { sources: { price: { kind: 'product', field: 'total_price_uah' } }, bindings: [], tables: {}, groups: [{ route: 'SV', name: 'Сувеніри', columns: ['name', 'price'], rows: [{ id: 'base', cells: { name: { op: 'literal', value: 'Сувенір' }, price: { op: 'source', id: 'price' } } }] }] };

it('distinguishes the public article source from a historical internal SKU source', () => {
  const identitySources = { ...definition, sources: { public: { kind: 'product', field: 'public_sku' }, internal: { kind: 'product', field: 'full_sku' } } };
  expect(sourceLabel(identitySources, 'public')).toBe('Артикул');
  expect(sourceLabel(identitySources, 'internal')).toBe('Внутрішній SKU');
});

it('shows persisted sources and exact ownership without inventing evaluated examples or changing the definition', () => {
  const onSelect = vi.fn(); const original = JSON.stringify(definition);
  const revision = { bindings: { attributes: [{ routeKey: 'SV:normal', rowId: 'base', target: 'price', bindingKey: 'price' }], policies: [{ bindingKey: 'price', policy: 'authoritative_create_update', reviewState: 'approved' }] } };
  render(<IntegrationRulesTable definition={definition} groupIndex={0} revision={revision} readOnly onSelect={onSelect} />);
  expect(screen.getByText('Оновлюється з менеджера')).toBeTruthy();
  expect(screen.getByText('Після перевірки товару')).toBeTruthy();
  expect(screen.getByText('Постійне значення')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Ціна' }));
  expect(onSelect).toHaveBeenCalledWith('price', 0); expect(JSON.stringify(definition)).toBe(original);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Пошук поля' }), { target: { value: 'Ціна' } });
  expect(screen.queryByRole('button', { name: 'Назва товару' })).toBeNull();
});

it('a draft without binding evidence makes no claim about active delivery ownership', () => {
  render(<IntegrationRulesTable definition={definition} groupIndex={0} readOnly onSelect={vi.fn()} />);
  expect(screen.getAllByText('Визначається опублікованими відповідностями')).toHaveLength(2);
  expect(screen.queryByText('Оновлюється з менеджера')).toBeNull();
});

it('reads policy text from the shared presenter while retaining unresolved policy fallbacks', () => {
  const label = vi.spyOn(policyLabels, 'deliveryPolicyLabel').mockReturnValue('Спільний підпис політики');
  const revision = { bindings: { attributes: [{ routeKey: 'SV:normal', rowId: 'base', target: 'price', bindingKey: 'price' }],
    policies: [{ bindingKey: 'price', policy: 'magento_managed', reviewState: 'approved' }] } };
  const view = render(<IntegrationRulesTable definition={definition} groupIndex={0} revision={revision} readOnly onSelect={vi.fn()} />);
  expect(within(screen.getByRole('button', { name: 'Ціна' }).closest('tr')).getByText('Спільний підпис політики')).toBeTruthy();
  expect(label).toHaveBeenCalledWith('magento_managed');
  label.mockRestore();
  revision.bindings.policies[0] = { ...revision.bindings.policies[0], policy: 'unknown' };
  view.rerender(<IntegrationRulesTable definition={definition} groupIndex={0} revision={revision} readOnly onSelect={vi.fn()} />);
  expect(screen.getByText('Правило потребує перевірки')).toBeTruthy();
  revision.bindings.policies[0].reviewState = 'review_required';
  view.rerender(<IntegrationRulesTable definition={definition} groupIndex={0} revision={revision} readOnly onSelect={vi.fn()} />);
  expect(screen.getAllByText('Поведінку ще не підтверджено')).toHaveLength(2);
});

it('the ordinary integration inspector edits a Magento value with the existing explicit draft transaction', () => {
  const initial = { formatVersion: 1, evaluatorVersion: 'magento-declarative-3', outputContract: 'magento-products-v1', ...definition };
  const change = vi.fn();
  render(<DefinitionEditor integration definition={initial} registry={{}} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Назва товару' }));
  expect(screen.getByRole('dialog', { name: 'Налаштування поля' })).toBeTruthy();
  expect(screen.queryByLabelText('Текст у файлі')).toBeNull();
  fireEvent.change(screen.getByLabelText('Значення для Magento'), { target: { value: 'Нова назва' } });
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Застосувати до чернетки' }));
  expect(change).toHaveBeenCalledTimes(1);
  expect(change.mock.calls[0][0].groups[0].rows[0].cells.name.value).toBe('Нова назва');
  expect(initial.groups[0].rows[0].cells.name.value).toBe('Сувенір');
});
