import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QuestionForm } from '../src/components/admin/AdminCatalogForms.jsx';
afterEach(cleanup);
function Settings({ onSave }) {
  const [question, setQuestion] = useState({ key: 'length', label: 'Розмір', input_type: 'text', required: false,
    include_in_sku: false, display_order: 1, sku_index: 0, visible_if_json: '', numeric_validation: null });
  return <QuestionForm config={{ categories: {}, questions: {} }} currentCatQuestions={[]} isNew question={question}
    onChange={setQuestion} onCancel={() => {}} onSave={() => onSave(question)} />;
}
it('numeric definition settings retain the selected type, unit, independent bounds and decimal precision for save', () => {
  const onSave = vi.fn(); render(<Settings onSave={onSave} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Перевірка' }), { target: { value: 'integer' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Одиниця' }), { target: { value: 'мм' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Мінімум' }), { target: { value: '1' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Максимум' }), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Включати мінімум' }));
  expect(screen.queryByRole('textbox', { name: 'Цифр після коми' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  expect(onSave.mock.calls[0][0].numeric_validation).toEqual({ kind: 'integer', unit: 'мм', min: '1', max: '30', minInclusive: false, maxInclusive: true, maxFractionDigits: 0 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Перевірка' }), { target: { value: 'decimal' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Одиниця' }), { target: { value: 'г' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Мінімум' }), { target: { value: '0' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Максимум' }), { target: { value: '30,5' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Цифр після коми' }), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Включати максимум' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  expect(onSave.mock.calls[1][0].numeric_validation).toEqual({ kind: 'decimal', unit: 'г', min: '0', max: '30,5', minInclusive: true, maxInclusive: false, maxFractionDigits: '2' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Перевірка' }), { target: { value: 'text' } });
  expect(screen.queryByRole('textbox', { name: 'Одиниця' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  expect(onSave.mock.calls[2][0].numeric_validation).toBeNull();
});
