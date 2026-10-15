import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import CatalogCharacteristics from '../src/components/workspace/CatalogCharacteristics.jsx';
import { characteristicUses } from '../src/lib/catalog-characteristics.js';

afterEach(cleanup);
const questions = [{ id: 'color', label: 'Колір', input_type: 'options', options: [{ id: 0, label: 'Нуль' }] }, { id: 'text', label: 'Напис', input_type: 'text', options: [] }, { id: 'guard', label: 'Обмеження', options: [] }, { id: 'unused', label: 'Примітка', options: [] }];
const source = (id) => ({ op: 'source', id });
const definition = { sources: Object.fromEntries(questions.map((question) => [question.id, { kind: 'semantic', category: 'BR', key: question.id }])), questionContracts: { guard: { source: 'guard' } }, bindings: [{ id: 'text', value: source('text') }], groups: [{ route: 'BR', rows: [{ id: 'base', cells: {
  custom_text: { op: 'ref', id: 'text' }, color: { op: 'when', if: source('guard'), then: source('color'), else: { op: 'literal', value: '' } },
  name: { op: 'join', items: [source('text'), source('color')] }, readiness: { op: 'questionValue', question: 'guard', value: { op: 'literal', value: '' } },
} }, { id: 'english', cells: { custom_text: source('text') } }] }] };

it('keeps conditional/readiness dependencies separate from transmitted values and keeps text attributes in the catalog', () => {
  const before = JSON.stringify(definition);
  const uses = characteristicUses(definition, 'BR', questions);
  expect(uses.get('guard').every((use) => use.kind === 'condition')).toBe(true);
  expect(uses.get('color')).toEqual([{ target: 'color', rowId: 'base', kind: 'attribute' }, { target: 'name', rowId: 'base', kind: 'text' }]);
  expect(uses.get('text').filter((use) => use.kind === 'attribute')).toHaveLength(2);
  expect(uses.get('unused')).toEqual([]);
  expect(JSON.stringify(definition)).toBe(before);
});

it('starts from Manager characteristics, describes local-only normally, and connects by exact identity', () => {
  const onConnect = vi.fn(); const onEdit = vi.fn();
  render(<CatalogCharacteristics questions={questions} definition={definition} categoryCode="BR" attributes={[{ target: 'custom_text', label: 'Гравіювання' }]} canEdit canConnect onEdit={onEdit} onConnect={onConnect} />);
  const guard = screen.getByRole('row', { name: /Обмеження/ });
  expect(guard.textContent).toContain('Лише Менеджер'); expect(guard.textContent).toContain('в умовах');
  expect(within(guard).queryByText(/помилка|потребує перевірки/i)).toBeNull();
  fireEvent.click(within(guard).getByRole('button', { name: 'Пов’язати з Magento' }));
  expect(onConnect).toHaveBeenCalledWith({ questionKey: 'guard' });
  fireEvent.click(screen.getByRole('button', { name: 'Напис' }));
  expect(onEdit).toHaveBeenCalledWith({ questionKey: 'text' });
  expect(screen.getAllByRole('button', { name: 'Гравіювання' })).toHaveLength(1);
});

it('keeps an exact repair characteristic visible across pagination and searches without hiding local-only values', () => {
  const many = Array.from({ length: 62 }, (_, index) => ({ id: `q${index}`, label: `Характеристика ${index}`, options: [] }));
  render(<CatalogCharacteristics questions={many} categoryCode="BR" selectedQuestion="q61" />);
  expect(screen.getByRole('row', { name: /Характеристика 61/ }).className).toBe('is-repair-target');
  fireEvent.click(screen.getByRole('button', { name: 'Далі' }));
  expect(screen.getByText('2 / 3')).toBeTruthy();
  fireEvent.change(screen.getByRole('searchbox', { name: 'Пошук характеристики' }), { target: { value: 'Характеристика 55' } });
  expect(screen.getByRole('row', { name: /Характеристика 55/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Далі' })).toBeNull();
});
