import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CategoryForm, OptionForm, OptionRow, QuestionForm } from '../src/components/admin/AdminCatalogForms.jsx';

afterEach(cleanup);
const legacy = { categories: {}, questions: {} };
const native = { ...legacy, catalogWorkflow: { identityMode: 'public_identity', serverGeneratedQuestionKeys: true } };
const material = { id: 'material', label: 'Матеріал', options: [{ id: 0, label: 'Бурштин' }] };
const initialCategory = { code: 'BR', name: 'Браслети', requires_weight: true, skip_hidden_sku_questions: false, marketing_rounding_enabled: true };
const initialQuestion = { key: 'size', label: 'Розмір', input_type: 'options', required: true,
  include_in_sku: true, display_order: 2, sku_index: 1, sku_separator: '-', visible_if_json: '', numeric_validation: null };
const initialOption = { db_id: 21, value_id: '0', sku_code: '01', label: 'Нуль', label_en: 'Zero',
  visible_if_json: '', hidden_if_json: '' };
function CategoryEditor({ initial = initialCategory, onSave = vi.fn(), ...props }) {
  const [category, onChange] = useState(initial);
  return <CategoryForm category={category} onChange={onChange} onSave={() => onSave(category)} {...props} />;
}
function QuestionEditor({ initial = initialQuestion, config = legacy, onSave = vi.fn(), ...props }) {
  const [question, onChange] = useState(initial);
  return <QuestionForm question={question} onChange={onChange} config={config} currentCatQuestions={[material]}
    onSave={() => onSave(question)} {...props} />;
}
function OptionEditor({ initial = initialOption, config = legacy, onSave = vi.fn(), ...props }) {
  const [option, onChange] = useState(initial);
  return <OptionForm option={option} onChange={onChange} config={config} currentCatQuestions={[material]}
    onSave={() => onSave(option)} {...props} />;
}
function openDetails(title) {
  const details = screen.getByText(title, { selector: 'summary' }).closest('details');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  return details;
}

it('keeps category flags independent and submits the normalized code only on explicit save', () => {
  const onSave = vi.fn(), onCancel = vi.fn(); render(<CategoryEditor onSave={onSave} onCancel={onCancel} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Код' }), { target: { value: 'nm' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Намиста' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Потрібна вага' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Пропускати приховані питання в SKU' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Маркетингове округлення автоматичних цін' }));
  expect(onSave).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ code: 'NM', name: 'Намиста', requires_weight: false,
    skip_hidden_sku_questions: true, marketing_rounding_enabled: false });
  fireEvent.click(screen.getByRole('button', { name: 'Закрити' })); expect(onCancel).toHaveBeenCalledOnce();
});

it('disables a used category code and keeps native historical settings collapsed until opened', () => {
  const onSave = vi.fn(); render(<CategoryEditor native isEdit initial={{ ...initialCategory, code_mutable: false }} onSave={onSave} />);
  const code = screen.getByRole('textbox', { name: /Код категорії/ });
  expect(code.disabled).toBe(true); expect(code.value).toBe('BR');
  expect(screen.queryByRole('checkbox', { name: 'Пропускати приховані питання в SKU' })).toBeNull();
  const details = openDetails('Історичні внутрішні SKU');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Пропускати приховані питання в SKU' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(onSave.mock.lastCall[0]).toEqual({ ...initialCategory, code_mutable: false, skip_hidden_sku_questions: true });
  details.open = false; fireEvent(details, new Event('toggle'));
  expect(screen.queryByRole('checkbox', { name: 'Пропускати приховані питання в SKU' })).toBeNull();
});

it('retains the existing native technical key as read-only while allowing display-order changes', () => {
  const onSave = vi.fn(); render(<QuestionEditor config={native} onSave={onSave} />);
  openDetails('Технічні параметри');
  expect(screen.getByRole('textbox', { name: 'Ключ' }).readOnly).toBe(true);
  fireEvent.change(screen.getByRole('spinbutton', { name: /Порядок у формі/ }), { target: { value: '1.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(onSave.mock.lastCall[0]).toEqual({ ...initialQuestion, display_order: '1.5' });
});

it('excludes text questions from SKU and clears numeric validation when returning to options', () => {
  const onSave = vi.fn(); render(<QuestionEditor onSave={onSave} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Тип поля' }), { target: { value: 'text' } });
  const included = screen.getByRole('checkbox', { name: 'Додавати значення в SKU' });
  expect(included.checked).toBe(false); expect(included.disabled).toBe(true);
  openDetails('Перевірка введення · довільний текст');
  fireEvent.change(screen.getByRole('combobox', { name: 'Перевірка' }), { target: { value: 'decimal' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Мінімум' }), { target: { value: '0' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Тип поля' }), { target: { value: 'options' } });
  expect(screen.queryByRole('combobox', { name: 'Перевірка' })).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Додавати значення в SKU' }).checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...initialQuestion, include_in_sku: false, numeric_validation: null });
});

it('edits legacy question metadata and condition without replacing the remaining draft', () => {
  const onSave = vi.fn(), onCancel = vi.fn(); render(<QuestionEditor onSave={onSave} onCancel={onCancel} />);
  openDetails('Технічні параметри');
  fireEvent.change(screen.getByRole('textbox', { name: 'Ключ' }), { target: { value: 'width' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обовʼязкове' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: /Позиція у внутрішньому SKU/ }), { target: { value: '3' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Розділювач/ }), { target: { value: '/' } });
  openDetails('Коли показувати характеристику · завжди');
  fireEvent.change(screen.getByRole('combobox', { name: 'Показувати характеристику' }), { target: { value: 'conditional' } });
  fireEvent.click(screen.getByRole('button', { name: 'Бурштин' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...initialQuestion, key: 'width', required: false, sku_index: '3',
    sku_separator: '/', visible_if_json: '{"material":0}' });
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' })); expect(onCancel).toHaveBeenCalledOnce();
});

it('keeps semantic option values separate from digit-only legacy SKU codes', () => {
  const onSave = vi.fn(); render(<OptionEditor onSave={onSave} />);
  fireEvent.change(screen.getByRole('spinbutton', { name: /Внутрішнє значення/ }), { target: { value: '17' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Код у SKU/ }), { target: { value: 'x02-3a' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва українською' }), { target: { value: 'Значення' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...initialOption, value_id: '17', sku_code: '023', label: 'Значення' });
});

it('shows native technical and historical option values only in their explicit sections', () => {
  const onSave = vi.fn(); render(<OptionEditor config={native} onSave={onSave} />);
  // jsdom exposes controls inside closed native details to role queries; assert the disclosure itself.
  const technical = screen.getByText('Технічні параметри значення', { selector: 'summary' }).closest('details');
  expect(technical.open).toBe(false);
  expect(within(technical).getByRole('spinbutton', { name: /Внутрішнє значення/ }).value).toBe('0');
  expect(screen.queryByRole('textbox', { name: /Код у SKU/ })).toBeNull();
  openDetails('Технічні параметри значення');
  expect(technical.open).toBe(true);
  fireEvent.change(screen.getByRole('spinbutton', { name: /Внутрішнє значення/ }), { target: { value: '18' } });
  openDetails('Історичні внутрішні SKU');
  fireEvent.change(screen.getByRole('textbox', { name: /Код у SKU/ }), { target: { value: '07!' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(onSave.mock.lastCall[0]).toEqual({ ...initialOption, value_id: '18', sku_code: '07' });
});

it('creates option drafts without exposing identifiers and preserves separate visible and hidden conditions', () => {
  const onSave = vi.fn(), onCancel = vi.fn(); render(<OptionEditor isNew config={native} onSave={onSave} onCancel={onCancel} />);
  expect(screen.queryByLabelText(/Внутрішнє значення|Код у SKU/)).toBeNull();
  openDetails('Умови показу значення');
  fireEvent.change(screen.getByRole('combobox', { name: 'Показувати значення' }), { target: { value: 'conditional' } });
  fireEvent.click(screen.getByRole('button', { name: 'Бурштин' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Приховувати значення' }), { target: { value: 'conditional' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Бурштин' })[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти значення' }));
  expect(onSave.mock.lastCall[0]).toEqual({ ...initialOption, visible_if_json: '{"material":0}', hidden_if_json: '{"material":0}' });
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' })); expect(onCancel).toHaveBeenCalledOnce();
});

it.each([false, true])('dispatches option edit/archive/delete using the exact saved identity (archived=%s)', (archived) => {
  const onEdit = vi.fn(), onArchive = vi.fn(), onDelete = vi.fn();
  render(<OptionRow option={initialOption} archived={archived} config={legacy} currentCatQuestions={[material]}
    onEdit={onEdit} onArchive={onArchive} onDelete={onDelete} />);
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати Нуль' }));
  fireEvent.click(screen.getByRole('button', { name: `${archived ? 'Відновити' : 'Архівувати'} Нуль` }));
  fireEvent.click(screen.getByRole('button', { name: 'Видалити Нуль' }));
  expect(onEdit).toHaveBeenCalledExactlyOnceWith(initialOption);
  expect(onArchive).toHaveBeenCalledExactlyOnceWith(initialOption, !archived);
  expect(onDelete).toHaveBeenCalledExactlyOnceWith('option', 21);
  expect(screen.getByText('SKU 01')).toBeTruthy(); expect(screen.getByText('EN: Zero')).toBeTruthy();
});

it('presents archived conditional options to a read-only native viewer without management controls', () => {
  const onEdit = vi.fn(), onArchive = vi.fn(), onDelete = vi.fn();
  const option = { ...initialOption, visible_if_json: { material: 0 }, hidden_if_json: { material: 2 } };
  const { container } = render(<OptionRow option={option} archived canManage={false} config={native} currentCatQuestions={[material]}
    onEdit={onEdit} onArchive={onArchive} onDelete={onDelete} />);
  expect(screen.getByText('Архівний')).toBeTruthy(); expect(screen.getByText('За умовою').title).toContain('Бурштин');
  expect(within(container).queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryByText('SKU 01')).toBeNull();
  expect(onEdit).not.toHaveBeenCalled(); expect(onArchive).not.toHaveBeenCalled(); expect(onDelete).not.toHaveBeenCalled();
});
