import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModifierForm, ScenarioForm, ScenarioMatrix } from '../src/components/admin/AdminPricingForms.jsx';

afterEach(cleanup);

const questions = [
  { id: 'shape', label: 'Форма', options: [{ id: 1, label: 'Куля' }, { id: 2, label: 'Архівна', archived: 1 }] },
  { id: 'color', label: 'Колір', options: [{ id: 0, label: 'Прозорий' }] },
  { id: 'note', label: 'Примітка', input_type: 'text', options: [] },
];
const config = { categories: {}, questions: {} };
const initialScenario = {
  id: 12, name: 'Базовий', group_name: 'Натуральний', status: 'draft', priority: 0,
  price_mode: 'per_gram_usd', apply_modifiers: true, match_json: '', axis_x_key: 'shape',
  axis_y_key: '', weight_bands: [], matrix: [{ x_val: 1, y_val: 0, price: 12.5 }],
};
function ScenarioEditor({ initial = initialScenario, requiresWeight = true, onSave = vi.fn(), onCancel, isNew = true }) {
  const [scenario, setScenario] = useState(initial);
  return <ScenarioForm config={config} currentCatQuestions={questions} groupOptions={['Натуральний', 'Формований']}
    scenario={scenario} setScenario={setScenario} selectedCat={{ requires_weight: requiresWeight ? 1 : 0 }}
    isNew={isNew} onCancel={onCancel} onSave={() => onSave(scenario)} />;
}
function ModifierEditor({ initial = { factor: '1', match_json: '' }, onSave = vi.fn(), onCancel, isNew = false }) {
  const [modifier, setModifier] = useState(initial);
  return <ModifierForm config={config} currentCatQuestions={questions} modifier={modifier} setModifier={setModifier}
    onSave={() => onSave(modifier)} onCancel={onCancel} isNew={isNew} />;
}
function matrixProps(overrides = {}) {
  return { scenario: initialScenario, currentCatQuestions: questions, handlePriceChange: vi.fn(),
    setMatrixValidationError: vi.fn(), ...overrides };
}
const cell = () => screen.getByRole('textbox', { name: 'Куля, Base' });

it('saves a positive comma-decimal cell on blur using its exact scenario and axis identities', () => {
  const props = matrixProps(); render(<ScenarioMatrix {...props} />);
  expect(screen.queryByRole('textbox', { name: 'Архівна, Base' })).toBeNull();
  fireEvent.change(cell(), { target: { value: '25,75' } });
  expect(props.handlePriceChange).not.toHaveBeenCalled();
  fireEvent.blur(cell());
  expect(cell().value).toBe('25.75');
  expect(props.handlePriceChange).toHaveBeenCalledExactlyOnceWith(12, 1, 0, '25.75');
  expect(props.setMatrixValidationError).toHaveBeenLastCalledWith('');
});

it('deletes an explicitly cleared matrix cell with null rather than zero', () => {
  const props = matrixProps(); render(<ScenarioMatrix {...props} />);
  fireEvent.change(cell(), { target: { value: '' } }); fireEvent.blur(cell());
  expect(props.handlePriceChange).toHaveBeenCalledExactlyOnceWith(12, 1, 0, null);
});

it.each(['0', '-4', 'Infinity', 'not-a-price'])('rejects invalid matrix input %s and restores the saved price', (value) => {
  const props = matrixProps(); render(<ScenarioMatrix {...props} />);
  const saved = cell().value;
  fireEvent.change(cell(), { target: { value } }); fireEvent.blur(cell());
  expect(cell().value).toBe(saved);
  expect(props.handlePriceChange).not.toHaveBeenCalled();
  expect(props.setMatrixValidationError).toHaveBeenCalledExactlyOnceWith('Ціна в матриці повинна бути більшою за 0.');
});

it('restores an absent cell to blank after invalid input without creating a price', () => {
  const props = matrixProps({ scenario: { ...initialScenario, matrix: [] } }); render(<ScenarioMatrix {...props} />);
  fireEvent.change(cell(), { target: { value: '0' } }); fireEvent.blur(cell());
  expect(cell().value).toBe(''); expect(props.handlePriceChange).not.toHaveBeenCalled();
});

it.each([
  { value: '23', error: { response: { data: { error: 'Немає дозволу' } } }, message: 'Немає дозволу' },
  { value: '', error: new Error('З’єднання втрачено'), message: 'З’єднання втрачено' },
])('keeps a rejected matrix write explicit for value "$value" without retry', async ({ value, error, message }) => {
  const props = matrixProps({ handlePriceChange: vi.fn().mockRejectedValue(error) }); render(<ScenarioMatrix {...props} />);
  fireEvent.change(cell(), { target: { value } }); fireEvent.blur(cell());
  await waitFor(() => expect(props.setMatrixValidationError).toHaveBeenLastCalledWith(message));
  expect(props.handlePriceChange).toHaveBeenCalledTimes(1);
});

it('renders read-only matrices without save controls and never writes on blur', () => {
  const props = matrixProps({ readOnly: true, matrixCellSaveStates: { '12:1:0': { state: 'saving', message: 'Запис' } } });
  render(<ScenarioMatrix {...props} />);
  expect(cell().readOnly).toBe(true); fireEvent.blur(cell());
  expect(props.handlePriceChange).not.toHaveBeenCalled(); expect(props.setMatrixValidationError).not.toHaveBeenCalled();
  expect(screen.queryByText('Запис')).toBeNull();
  expect(screen.queryByText(/Зміни зберігаються автоматично/)).toBeNull();
});

it('renders the addressed cell error and replaces its draft when a new authoritative price arrives', () => {
  const props = matrixProps({ matrixValidationError: 'Перевірте ціну', matrixCellSaveStates: { '12:1:0': { state: 'error', message: 'Не збережено' } } });
  const { rerender } = render(<ScenarioMatrix {...props} />);
  expect(cell().getAttribute('aria-invalid')).toBe('true');
  expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining(['Перевірте ціну', 'Не збережено']));
  expect(screen.getByText('Не збережено')).toBeTruthy();
  fireEvent.change(cell(), { target: { value: '99' } });
  rerender(<ScenarioMatrix {...props} matrixCellSaveStates={{}} matrixValidationError=""
    scenario={{ ...initialScenario, matrix: [{ x_val: 1, y_val: 0, price: 27 }] }} />);
  expect(Number(cell().value)).toBe(27); expect(cell().hasAttribute('aria-invalid')).toBe(false);
});

it('preserves scenario settings and condition values in the explicit save callback', () => {
  const onSave = vi.fn(), onCancel = vi.fn(); render(<ScenarioEditor onSave={onSave} onCancel={onCancel} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва сценарію' }), { target: { value: 'Новий сценарій' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Група' }), { target: { value: 'Власна група' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Статус' }), { target: { value: 'active' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /Пріоритет/ }), { target: { value: '8' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Режим ціни' }), { target: { value: 'fixed_uah' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Застосовувати модифікатори після матриці' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Коли використовувати цей сценарій' }), { target: { value: 'conditional' } });
  fireEvent.click(screen.getByRole('button', { name: 'Куля' }));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Створити сценарій' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...initialScenario, name: 'Новий сценарій', group_name: 'Власна група',
    status: 'active', priority: '8', price_mode: 'fixed_uah', apply_modifiers: false, match_json: '{"shape":1}' });
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' })); expect(onCancel).toHaveBeenCalledOnce();
});

it('supports composite columns while clearing dependent selection when the primary axis changes', () => {
  const onSave = vi.fn(); render(<ScenarioEditor onSave={onSave} />);
  const rows = screen.getByRole('combobox', { name: 'Рядки матриці' });
  expect(within(rows).queryByRole('option', { name: 'Примітка' })).toBeNull();
  expect(within(rows).getByRole('option', { name: 'Вага' })).toBeTruthy();
  const columns = screen.getByRole('combobox', { name: 'Колонки матриці' });
  const extra = screen.getByRole('combobox', { name: /Додаткова колонка/ });
  expect(extra.disabled).toBe(true);
  fireEvent.change(columns, { target: { value: 'shape' } });
  expect(within(extra).queryByRole('option', { name: 'Форма' })).toBeNull();
  fireEvent.change(extra, { target: { value: 'color' } });
  fireEvent.click(screen.getByRole('button', { name: 'Створити сценарій' }));
  expect(onSave.mock.lastCall[0].axis_y_key).toBe('shape+color');
  fireEvent.change(columns, { target: { value: 'color' } }); expect(extra.value).toBe('');
  fireEvent.change(columns, { target: { value: '' } }); expect(extra.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Створити сценарій' })); expect(onSave.mock.lastCall[0].axis_y_key).toBe('');
});

it('does not offer weight axes for a category without weight', () => {
  render(<ScenarioEditor requiresWeight={false} />);
  const rows = screen.getByRole('combobox', { name: 'Рядки матриці' });
  expect(within(rows).queryByRole('option', { name: 'Вага' })).toBeNull();
  expect(within(rows).queryByRole('option', { name: 'Діапазон ваги' })).toBeNull();
});

it('initializes weight bands once and preserves exact edited boundaries across axis changes', () => {
  const onSave = vi.fn(); render(<ScenarioEditor onSave={onSave} />);
  const rows = screen.getByRole('combobox', { name: 'Рядки матриці' });
  fireEvent.change(rows, { target: { value: 'weight_band' } });
  expect(screen.getAllByRole('group', { name: /Ваговий діапазон/ })).toHaveLength(3);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва вагового діапазону 1' }), { target: { value: 'Легкий' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Початкова вага діапазону 1, включно' }), { target: { value: '1.5' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Кінцева вага діапазону 1, не включно' }), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Видалити ваговий діапазон 2: 10-15 г' }));
  fireEvent.click(screen.getByRole('button', { name: 'Додати діапазон' }));
  fireEvent.change(rows, { target: { value: 'shape' } }); fireEvent.change(rows, { target: { value: 'weight_band' } });
  fireEvent.click(screen.getByRole('button', { name: 'Створити сценарій' }));
  expect(onSave.mock.lastCall[0].weight_bands).toEqual([
    { label: 'Легкий', min_weight: '1.5', max_weight: '9' },
    { label: 'Від 15 г', min_weight: 15, max_weight: '' }, { label: '', min_weight: '', max_weight: '' },
  ]);
});

it.each([
  ['0.7', 'знижка 30%'], ['1', 'ціна без змін'], ['1.15', 'націнка 15%'],
])('explains modifier %s without changing the saved factor', (factor, description) => {
  const onSave = vi.fn(); render(<ModifierEditor initial={{ factor, match_json: '' }} onSave={onSave} />);
  expect(screen.getByRole('status').textContent).toBe(`Результат: ${description}`);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти модифікатор' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ factor, match_json: '' });
});

it('retains modifier conditions, refuses negative factor edits and leaves blank values for server validation', () => {
  const onSave = vi.fn(), onCancel = vi.fn(); render(<ModifierEditor isNew onSave={onSave} onCancel={onCancel} />);
  const factor = screen.getByRole('spinbutton', { name: /Множник/ });
  fireEvent.change(factor, { target: { value: '-2' } }); expect(factor.value).toBe('1');
  fireEvent.change(factor, { target: { value: '1.25' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Коли застосовувати модифікатор' }), { target: { value: 'conditional' } });
  fireEvent.click(screen.getByRole('button', { name: 'Куля' }));
  fireEvent.click(screen.getByRole('button', { name: 'Додати модифікатор' }));
  expect(onSave).toHaveBeenLastCalledWith({ factor: '1.25', match_json: '{"shape":1}' });
  fireEvent.change(factor, { target: { value: '' } }); expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' })); expect(onCancel).toHaveBeenCalledOnce();
  expect(onSave).toHaveBeenCalledTimes(1);
});
