import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminStructureEditor } from '../src/components/admin/AdminStructureEditor.jsx';

afterEach(cleanup);
const category = { code: 'BR', name: 'Браслети', requires_weight: 1, marketing_rounding_enabled: 1, skip_hidden_sku_questions: 0 };
const otherCategory = { code: 'NM', name: 'Намиста', requires_weight: 1 };
const options = [
  { db_id: 21, id: 0, label: 'Бурштин', label_en: 'Amber', sku_code: '7', archived: 0 },
  { db_id: 22, id: 1, label: 'Старий матеріал', sku_code: '8', archived: true },
];
const questions = [
  { id: 'material', q_db_id: 11, label: 'Матеріал', display_order: 1, sku_index: 1, sku_separator: '-', input_type: 'options', required: 1, include_in_sku: 1, options },
  { id: 'color', q_db_id: 12, label: 'Колір', display_order: 2, sku_index: 2, input_type: 'options', required: 0, include_in_sku: 1, options: [] },
  { id: 'note', q_db_id: 13, label: 'Примітка', display_order: 3, sku_index: 0, input_type: 'text', required: 0, include_in_sku: 0 },
];
const editCategory = { code: 'BR', name: 'Браслети', requires_weight: true, skip_hidden_sku_questions: false, marketing_rounding_enabled: true, code_mutable: true };
const editQuestion = { key: 'material', label: 'Матеріал', display_order: 1, sku_index: 1, required: true,
  include_in_sku: true, input_type: 'options', numeric_validation: null, sku_separator: '-', visible_if_json: '' };
const newQuestion = { key: '', label: '', display_order: '4', sku_index: '3', required: true,
  include_in_sku: false, input_type: 'options', numeric_validation: null, sku_separator: '', visible_if_json: '' };
const emptyOption = { id: null, value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false };
function propsFor(overrides = {}) {
  const callbacks = Object.fromEntries(['onSelectCategory', 'onSelectQuestion', 'addCategory', 'updateCategory', 'addQuestion',
    'updateQuestion', 'reorderQuestions', 'autoAssignSkuIndexes', 'fillNextNewQuestionSkuIndex', 'addOption', 'archiveOption',
    'archiveQuestion', 'beginOptionEdit', 'updateOption', 'publishSkuSchema', 'deleteItem', 'onDirtyChange', 'retrySchemaStatus'].map((key) => [key, vi.fn()]));
  return { ...callbacks, config: { categories: { BR: category, NM: otherCategory } }, selectedCat: category,
    selectedQuestion: questions[0], currentCatQuestions: questions, currentOptions: options, selectedQuestionInputType: 'options',
    schemaStatus: { active: { version: 2, marker: '2/' }, draftChanged: true, nextVersion: 3, nextMarker: '3/' },
    schemaPublishState: { loading: false }, canManage: true, canPublish: true, ...overrides };
}
function Editor({ props }) {
  const [editCat, setEditCat] = useState(editCategory);
  const [newCat, setNewCat] = useState({ code: '', name: '', requires_weight: true, skip_hidden_sku_questions: false, marketing_rounding_enabled: true });
  const [editQuest, setEditQuestion] = useState(editQuestion);
  const [newQuest, setNewQuest] = useState(newQuestion);
  const [newOpt, setNewOpt] = useState({ value_id: '', sku_code: '', label: '', label_en: '', visible_if_json: '', hidden_if_json: '', archived: false });
  const [editOpt, setEditOpt] = useState(props.initialEditOpt || emptyOption);
  return <MemoryRouter><AdminStructureEditor {...props} editCat={editCat} setEditCat={setEditCat} newCat={newCat} setNewCat={setNewCat}
    editQuestion={editQuest} setEditQuestion={setEditQuestion} newQuest={newQuest} setNewQuest={setNewQuest}
    newOpt={newOpt} setNewOpt={setNewOpt} editOpt={editOpt} setEditOpt={setEditOpt} /></MemoryRouter>;
}
const questionRow = (name) => screen.getByText(name, { selector: '.catalog-question-row strong' }).closest('[role="button"]');
function nativeProps(overrides = {}) {
  return propsFor({ config: { categories: { BR: category, NM: otherCategory }, catalogWorkflow: { identityMode: 'public_identity', serverGeneratedQuestionKeys: true } }, ...overrides });
}

it.each([false, true])('shows category guidance without attempting commands when no category is selected (native=%s)', (native) => {
  const props = (native ? nativeProps : propsFor)({ selectedCat: null, selectedQuestion: null, currentOptions: [], currentCatQuestions: [] });
  render(<Editor props={props} />);
  expect(screen.getByRole('heading', { name: 'Виберіть категорію' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Опублікувати/ })).toBeNull();
  expect(props.publishSkuSchema).not.toHaveBeenCalled(); expect(props.addCategory).not.toHaveBeenCalled();
});

it('shows empty question selection and preserves category selection for read-only viewers', () => {
  const props = propsFor({ canManage: false, canPublish: false, selectedQuestion: null, currentCatQuestions: [], currentOptions: [] });
  render(<Editor props={props} />);
  expect(screen.getByText('У категорії ще немає питань.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Виберіть питання' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Додати' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Намиста NM' }));
  expect(props.onSelectCategory).toHaveBeenCalledExactlyOnceWith(otherCategory);
});

it('marks only an edited open category draft dirty and clears the navigation guard on cancel and unmount', () => {
  const props = propsFor(); const { unmount } = render(<Editor props={props} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[0]);
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Код' }), { target: { value: 'ar' } });
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(screen.queryByRole('heading', { name: 'Нова категорія' })).toBeNull();
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false); expect(props.addCategory).not.toHaveBeenCalled();
  unmount(); expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('keeps existing category editing separate from creating and forwards only explicit saves', () => {
  const props = propsFor(); render(<Editor props={props} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[1]);
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Оновлені браслети' } });
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(props.updateCategory).toHaveBeenCalledOnce(); expect(props.addCategory).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[0]);
  expect(screen.queryByRole('heading', { name: 'Налаштування категорії' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Нова категорія' })).toBeTruthy();
});

it('keeps a native question draft after refusal and closes it only on an explicit successful result', async () => {
  let refuse;
  const refused = new Promise((resolve) => { refuse = resolve; });
  const props = nativeProps({ addQuestion: vi.fn().mockReturnValueOnce(refused).mockResolvedValueOnce(true) });
  render(<Editor props={props} />); fireEvent.click(screen.getByRole('button', { name: 'Додати', exact: true }));
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва характеристики' }), { target: { value: 'Нова ознака' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти характеристику' }));
  expect(props.addQuestion).toHaveBeenCalledTimes(1);
  await act(async () => refuse(false));
  expect(screen.getByRole('textbox', { name: 'Назва характеристики' }).value).toBe('Нова ознака');
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти характеристику' }));
  await waitFor(() => {
    expect(screen.queryByRole('textbox', { name: 'Назва характеристики' })).toBeNull();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  expect(props.addQuestion).toHaveBeenCalledTimes(2);
});

it('edits the selected question and clears its local editor before selecting another question', () => {
  const props = propsFor(); render(<Editor props={props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати', exact: true }));
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва характеристики' }), { target: { value: 'Матеріал виробу' } });
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' })); expect(props.updateQuestion).toHaveBeenCalledOnce();
  fireEvent.keyDown(questionRow('Колір'), { key: ' ' });
  expect(props.onSelectQuestion).toHaveBeenCalledExactlyOnceWith(questions[1]);
  expect(screen.queryByRole('textbox', { name: 'Назва характеристики' })).toBeNull();
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('forwards category and question lifecycle actions with their real distinct identities', () => {
  const props = propsFor(); render(<Editor props={props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Видалити категорію Браслети' }));
  fireEvent.click(screen.getByRole('button', { name: 'Архівувати питання' }));
  fireEvent.click(screen.getByRole('button', { name: 'Видалити питання Матеріал' }));
  expect(props.deleteItem.mock.calls).toEqual([['category', 'BR'], ['question', 11]]);
  expect(props.archiveQuestion).toHaveBeenCalledExactlyOnceWith(questions[0], true);
});

it('restores an archived question without conflating its archived flag with option state', () => {
  const archived = { ...questions[0], archived: 1 };
  const props = propsFor({ selectedQuestion: archived }); render(<Editor props={props} />);
  expect(screen.getByRole('heading', { name: 'Матеріал · Архівне' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Відновити питання' }));
  expect(props.archiveQuestion).toHaveBeenCalledExactlyOnceWith(archived, false);
});

it('separates active and archived options and forwards their selected identities', () => {
  const props = propsFor(); render(<Editor props={props} />);
  expect(screen.getByText('1 активних · 1 в архіві')).toBeTruthy();
  expect(screen.queryByText('Старий матеріал')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Архівні варіанти (1)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Відновити Старий матеріал' }));
  fireEvent.click(screen.getByRole('button', { name: 'Редагувати Бурштин' }));
  expect(props.archiveOption).toHaveBeenCalledExactlyOnceWith(options[1], false);
  expect(props.beginOptionEdit).toHaveBeenCalledExactlyOnceWith(options[0]);
});

it('clears an unsaved new-option editor when switching category without saving it', () => {
  const props = propsFor(); render(<Editor props={props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Додати варіант' }));
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва українською' }), { target: { value: 'Новий матеріал' } });
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Намиста NM' }));
  expect(screen.queryByRole('textbox', { name: 'Назва українською' })).toBeNull();
  expect(props.onSelectCategory).toHaveBeenCalledExactlyOnceWith(otherCategory);
  expect(props.addOption).not.toHaveBeenCalled(); expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('tracks existing-option edits and resets them on explicit cancel', () => {
  const initialEditOpt = { id: 21, value_id: '0', sku_code: '7', label: 'Бурштин', label_en: 'Amber', visible_if_json: '', hidden_if_json: '', archived: false };
  const props = propsFor({ initialEditOpt }); render(<Editor props={props} />);
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва українською' }), { target: { value: 'Змінений бурштин' } });
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' })); expect(props.updateOption).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(screen.queryByRole('heading', { name: 'Редагування значення' })).toBeNull();
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('does not offer option creation for a text question or management actions to a viewer', () => {
  const props = propsFor({ canManage: false, canPublish: false, selectedQuestion: questions[2], selectedQuestionInputType: 'text', currentOptions: [] });
  render(<Editor props={props} />);
  expect(screen.getByText('Для текстового питання варіанти не використовуються.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Додати|Редагувати|Видалити|Архівувати|Переіндексувати|Опублікувати/ })).toBeNull();
  fireEvent.keyDown(questionRow('Матеріал'), { altKey: true, key: 'ArrowDown' });
  expect(props.reorderQuestions).not.toHaveBeenCalled();
});

it('keeps publication unavailable while unchanged or busy and presents retryable schema errors', () => {
  const props = propsFor({ schemaStatus: { draftChanged: false, active: { version: 2 } }, schemaStatusError: 'unavailable' });
  const { rerender } = render(<Editor props={props} />);
  expect(screen.getByRole('button', { name: 'Опублікувати' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' })); expect(props.retrySchemaStatus).toHaveBeenCalledOnce();
  rerender(<Editor props={{ ...props, schemaStatus: { draftChanged: true, nextVersion: 3 },
    schemaPublishState: { loading: true, otherCategory: true, categoryName: 'Намиста', error: 'Версія змінилась' } }} />);
  expect(screen.getByRole('button', { name: 'Публікується «Намиста»…' }).disabled).toBe(true);
  expect(screen.getByText('Версія змінилась')).toBeTruthy(); expect(screen.getByRole('status').textContent).toContain('«Намиста»');
  expect(props.publishSkuSchema).not.toHaveBeenCalled();
});

it('forwards an explicit allowed schema publication and reindex operation', () => {
  const props = propsFor(); render(<Editor props={props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Опублікувати V3' }));
  fireEvent.click(screen.getByRole('button', { name: 'Переіндексувати SKU' }));
  expect(props.publishSkuSchema).toHaveBeenCalledOnce(); expect(props.autoAssignSkuIndexes).toHaveBeenCalledOnce();
});

it('moves questions with keyboard commands without allowing the first/last row to escape the category', () => {
  const props = propsFor(); render(<Editor props={props} />);
  fireEvent.keyDown(questionRow('Матеріал'), { altKey: true, key: 'ArrowUp' });
  fireEvent.keyDown(questionRow('Примітка'), { altKey: true, key: 'ArrowDown' });
  expect(props.reorderQuestions).not.toHaveBeenCalled();
  fireEvent.keyDown(questionRow('Колір'), { altKey: true, key: 'ArrowUp' });
  expect(props.reorderQuestions).toHaveBeenCalledExactlyOnceWith([questions[1], questions[0], questions[2]]);
});

function dragEvent(element, type, transfer, clientY = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, 'dataTransfer', { value: transfer }); fireEvent(element, event);
}
it.each([
  { clientY: 10, expected: [questions[1], questions[0], questions[2]] },
  { clientY: 90, expected: [questions[1], questions[2], questions[0]] },
])('preserves all question identities when dropping before/after a row at y=$clientY', ({ clientY, expected }) => {
  const props = propsFor(); render(<Editor props={props} />);
  const source = questionRow('Матеріал'), target = questionRow('Примітка');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 100 });
  const transfer = { setData: vi.fn(), getData: vi.fn(() => '11') };
  dragEvent(source, 'dragstart', transfer); expect(transfer.setData).toHaveBeenCalledWith('text/plain', '11');
  dragEvent(target, 'dragover', transfer, clientY); dragEvent(target, 'drop', transfer, clientY);
  expect(props.reorderQuestions).toHaveBeenCalledExactlyOnceWith(expected);
  expect(questions.map(({ q_db_id }) => q_db_id)).toEqual([11, 12, 13]);
});

it.each(['11', '999', ''])('ignores same-row or unknown drag identity "%s" without a reorder', (id) => {
  const props = propsFor(); render(<Editor props={props} />);
  const transfer = { getData: () => id };
  dragEvent(questionRow('Матеріал'), 'drop', transfer, 0);
  expect(props.reorderQuestions).not.toHaveBeenCalled();
});

it('focuses an entry draft only after its exact question is selected, without stealing later focus', () => {
  const entryAction = { action: 'new-option', key: 'entry-1', questionDbId: 11 };
  const props = propsFor({ entryAction, selectedQuestion: questions[1] });
  const { rerender } = render(<Editor props={props} />);
  const input = screen.getByRole('textbox', { name: 'Назва українською' });
  expect(document.activeElement).not.toBe(input);
  rerender(<Editor props={{ ...props, selectedQuestion: questions[0] }} />);
  expect(document.activeElement).toBe(input);
  const otherControl = screen.getByRole('button', { name: 'Намиста NM' }); otherControl.focus();
  rerender(<Editor props={{ ...props, selectedQuestion: questions[0], schemaStatus: { ...props.schemaStatus } }} />);
  expect(document.activeElement).toBe(otherControl);
});
