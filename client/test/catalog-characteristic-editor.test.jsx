import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import { CatalogCategoryEditor, CatalogCharacteristicEditor } from '../src/components/admin/CatalogCharacteristicEditor.jsx';

let config, get, post, put, patch;
const category = { code: 'BR', name: 'Браслети', requires_weight: 1, marketing_rounding_enabled: 1, skip_hidden_sku_questions: 1, code_mutable: false };
const originalQuestion = { id: 'color', q_db_id: 84, label: 'Колір', input_type: 'options', required: 0,
  include_in_sku: 1, sku_index: 2, display_order: 1, sku_separator: '-', archived: false,
  options: [{ id: 0, db_id: 31, label: 'Без кольору', label_en: 'No color', sku_code: '0', archived: false }] };
beforeEach(() => {
  config = { categories: { BR: category }, questions: { BR: [structuredClone(originalQuestion)] }, extraConfig: {},
    catalogWorkflow: { identityMode: 'public_identity', serverGeneratedQuestionKeys: true } };
  get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return { data: structuredClone(config) };
    throw Error('Magento is unavailable: ' + url);
  });
  post = vi.spyOn(api, 'post').mockRejectedValue(Error('Unexpected mutation'));
  put = vi.spyOn(api, 'put').mockRejectedValue(Error('Unexpected mutation'));
  patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: { success: true } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open(props = {}, permissions = ['catalog.view', 'catalog.manage'], component = CatalogCharacteristicEditor) {
  const Component = component;
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onDirtyChange: vi.fn(), onBusyChange: vi.fn(), onConnect: vi.fn(), ...props };
  render(<AuthContext.Provider value={{ permissions, roles: [] }}><Component categoryCode="BR" questionKey="color" {...callbacks} /></AuthContext.Provider>);
  return callbacks;
}

it('creates a local characteristic while Magento is unavailable and connects only the exact returned key', async () => {
  const key = 'q_authoritative';
  post.mockImplementation(async (url, payload) => {
    expect(url).toBe('/admin/question');
    config.questions.BR.push({ ...payload, id: key, q_db_id: 91, label: payload.label, options: [] });
    return { data: { id: 91, key } };
  });
  const callbacks = open({ questionKey: null, initialAction: 'new-question' });
  fireEvent.change(await screen.findByRole('textbox', { name: 'Назва характеристики' }), { target: { value: 'Колір' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти характеристику' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledExactlyOnceWith({ kind: 'question', action: 'created', categoryCode: 'BR', questionId: 91, questionKey: key }));
  expect(post.mock.calls[0][1]).not.toHaveProperty('key');
  expect(post.mock.calls[0][1]).not.toHaveProperty('include_in_sku');
  expect(callbacks.onConnect).not.toHaveBeenCalled();
  const connect = await screen.findByRole('button', { name: 'Налаштувати передавання' });
  await waitFor(() => expect(connect.disabled).toBe(false));
  fireEvent.click(connect);
  await waitFor(() => expect(callbacks.onConnect).toHaveBeenCalledExactlyOnceWith({ questionKey: key }));
  expect(get.mock.calls.every(([url]) => url === '/admin/config')).toBe(true);
});

it('retains the exact newly created value and the local receipt after a failed shop handoff', async () => {
  post.mockImplementation(async (url, payload) => {
    expect(url).toBe('/admin/option');
    config.questions.BR[0].options.push({ id: 204, db_id: 89, label: payload.label, label_en: payload.label_en });
    return { data: { id: 89, value_id: 204 } };
  });
  const callbacks = open({ initialAction: 'new-option', onConnect: vi.fn().mockRejectedValue(Error('offline')) });
  fireEvent.change(await screen.findByRole('textbox', { name: 'Назва українською' }), { target: { value: 'Без кольору' } });
  fireEvent.change(screen.getByRole('textbox', { name: /Назва англійською/ }), { target: { value: 'Second label' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти значення' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledWith(expect.objectContaining({ optionId: 89, valueId: 204, questionKey: 'color' })));
  const connect = await screen.findByRole('button', { name: 'Налаштувати передавання' });
  await waitFor(() => expect(connect.disabled).toBe(false));
  fireEvent.click(connect);
  await screen.findByText(/Налаштування магазину недоступні/);
  expect(callbacks.onConnect).toHaveBeenCalledExactlyOnceWith({ questionKey: 'color', valueId: 204 });
  expect(screen.getByText('Second label')).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(1);
});

it('edits semantic zero by the exact row ID while preserving encoded fields and EN metadata', async () => {
  put.mockResolvedValue({ data: { success: true } });
  const callbacks = open({ initialAction: 'edit-option', optionValue: 0 });
  fireEvent.change(await screen.findByRole('textbox', { name: 'Назва українською' }), { target: { value: 'Без відтінку' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  await waitFor(() => expect(put).toHaveBeenCalledExactlyOnceWith('/admin/option', expect.objectContaining({ id: 31, value_id: '0', sku_code: '0', label: 'Без відтінку', label_en: 'No color' })));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledWith(expect.objectContaining({ optionId: 31, valueId: 0 })));
});

it('does not substitute another option when the requested semantic value is missing', async () => {
  open({ initialAction: 'edit-option', optionValue: 999 });
  await screen.findByText('Значення не знайдено');
  expect(screen.queryByRole('textbox', { name: 'Назва українською' })).toBeNull();
  expect(post).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
});

it('requires an exact row for contextual aliases sharing a semantic ID', async () => {
  config.questions.BR[0].options.push({ ...originalQuestion.options[0], db_id: 32, label: 'Інший контекст' });
  open({ initialAction: 'edit-option', optionValue: 0 });
  await screen.findByText('Значення не знайдено');
  cleanup();
  open({ initialAction: 'edit-option', optionValue: 0, optionId: 32 });
  expect((await screen.findByRole('textbox', { name: 'Назва українською' })).value).toBe('Інший контекст');
});

it('preserves dirty input when cancelling dismissal and blocks duplicate writes while saving', async () => {
  let resolveSave;
  post.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
  const callbacks = open();
  const input = await screen.findByRole('textbox', { name: 'Назва характеристики' });
  fireEvent.change(input, { target: { value: 'Колір прикраси' } });
  await waitFor(() => expect(callbacks.onDirtyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  const dialog = await screen.findByRole('dialog', { name: 'Відкинути незбережені зміни?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
  expect(input.value).toBe('Колір прикраси'); expect(callbacks.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  await waitFor(() => expect(callbacks.onBusyChange).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => resolveSave({ data: { success: true, key: 'color' } }));
  await waitFor(() => expect(callbacks.onBusyChange).toHaveBeenLastCalledWith(false));
  await waitFor(() => expect(callbacks.onDirtyChange).toHaveBeenLastCalledWith(false));
});

it('keeps successful local archive distinct from a failed refresh and does not dispatch Magento', async () => {
  post.mockResolvedValue({ data: { success: true, key: 'color' } });
  const callbacks = open();
  await screen.findByRole('textbox', { name: 'Назва характеристики' });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  const archive = await screen.findByRole('button', { name: 'Архівувати характеристику' });
  await waitFor(() => expect(archive.disabled).toBe(false));
  get.mockRejectedValueOnce(Error('refresh unavailable'));
  fireEvent.click(archive);
  await screen.findByText('Характеристику перенесено в архів, але дані не оновлено');
  expect(patch).toHaveBeenCalledExactlyOnceWith('/admin/question/84/archive', { archived: true });
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'archived', questionId: 84 })));
  expect(callbacks.onConnect).not.toHaveBeenCalled();
});

it('keeps mutations disabled without catalog.manage', async () => {
  open({}, ['catalog.view']);
  const input = await screen.findByRole('textbox', { name: 'Назва характеристики' });
  expect(input.closest('fieldset').disabled).toBe(true);
  expect(post).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
});

it('creates a category using the returned normalized code without publishing or connecting it', async () => {
  post.mockResolvedValue({ data: { id: 'NEW', name: 'Нова категорія' } });
  const callbacks = open({ categoryCode: null }, undefined, CatalogCategoryEditor);
  fireEvent.change(await screen.findByRole('textbox', { name: /Код категорії/ }), { target: { value: 'new' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Нова категорія' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledExactlyOnceWith({ kind: 'category', action: 'created', categoryCode: 'NEW' }));
  expect(post).toHaveBeenCalledExactlyOnceWith('/admin/category', expect.objectContaining({ code: 'NEW', name: 'Нова категорія' }));
});

it('pages and searches values by either language while editing the exact selected row', async () => {
  config.questions.BR[0].options = Array.from({ length: 52 }, (_, index) => ({ id: index, db_id: index + 31, label: `Значення ${index}`, label_en: `English ${index}`, sku_code: String(index) }));
  open({ initialAction: 'summary' });
  const region = await screen.findByRole('region', { name: 'Значення характеристики' });
  expect(within(region).getAllByRole('row')).toHaveLength(26);
  expect(within(region).queryByRole('button', { name: 'Редагувати Значення 51' })).toBeNull();
  fireEvent.click(within(region).getByRole('button', { name: 'Далі' }));
  expect(within(region).getByRole('button', { name: 'Редагувати Значення 25' })).toBeTruthy();
  fireEvent.change(within(region).getByRole('searchbox', { name: 'Пошук значення' }), { target: { value: 'English 51' } });
  fireEvent.click(within(region).getByRole('button', { name: 'Редагувати Значення 51' }));
  expect(screen.getByRole('textbox', { name: 'Назва українською' }).value).toBe('Значення 51');
  expect(post).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
});

it('empty hide conditions say never hide and preserve semantic zero when a condition is chosen', async () => {
  config.questions.BR.push({ ...originalQuestion, id: 'source', q_db_id: 85, label: 'Інша характеристика' });
  let resolveConfig;
  get.mockImplementationOnce(() => new Promise((resolve) => { resolveConfig = resolve; }));
  open({ initialAction: 'edit-option', optionValue: 0 });
  await waitFor(() => expect(get).toHaveBeenCalledWith('/admin/config'));
  expect(screen.getByText('Завантажуємо каталог…')).toBeTruthy();
  // Settle option initialization and the condition builder's prop synchronization before editing.
  await act(async () => resolveConfig({ data: structuredClone(config) }));
  expect((await screen.findByRole('textbox', { name: 'Назва українською' })).value).toBe('Без кольору');
  fireEvent.click(await screen.findByText('Умови показу значення'));
  const hide = screen.getByRole('combobox', { name: 'Приховувати значення' });
  expect(hide.selectedOptions[0].textContent).toBe('Не приховувати');
  await act(async () => fireEvent.change(hide, { target: { value: 'conditional' } }));
  const condition = hide.closest('.mb-3');
  const zero = await within(condition).findByRole('button', { name: 'Без кольору' });
  expect(hide.value).toBe('conditional');
  fireEvent.click(zero);
  expect(within(condition).getByRole('button', { name: 'Без кольору' }).getAttribute('aria-pressed')).toBe('true');
  put.mockResolvedValue({ data: { success: true } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/option', expect.objectContaining({ hidden_if_json: { source: 0 } })));
});
