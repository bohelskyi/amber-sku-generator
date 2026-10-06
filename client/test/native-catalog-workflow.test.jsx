import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AdminPage from '../src/pages/AdminPage.jsx';

const category = { code: 'BR', name: 'Браслети', requires_weight: 1, skip_hidden_sku_questions: 1, marketing_rounding_enabled: 1, code_mutable: false };
const question = { id: 'color', q_db_id: 84, label: 'Колір бурштину', input_type: 'options', required: 0,
  include_in_sku: 1, sku_index: 2, display_order: 1, sku_separator: '-', options: [] };
let config, post;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  config = { categories: { BR: category }, questions: { BR: [question] }, extraConfig: {},
    catalogWorkflow: { identityMode: 'public_identity', serverGeneratedQuestionKeys: true } };
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return { data: config };
    if (url === '/admin/sku-schema/BR') return { data: { active: { version: 1 }, draftChanged: true, nextVersion: 2 } };
    throw Error('Unexpected read ' + url);
  });
  post = vi.spyOn(api, 'post').mockResolvedValue({ data: { id: 85, key: 'q_' + 'a'.repeat(32) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open(action = 'new-question', permissions = ['catalog.view', 'catalog.manage', 'sku_schemas.publish', 'export_templates.view']) {
  const auth = { permissions, roles: [], principalLifetime: { id: 'catalog-native-test', valid: true } };
  const router = createMemoryRouter([{ path: '*', element: <AdminPage mode="catalog" /> }],
    { initialEntries: ['/admin/catalog?' + new URLSearchParams({ category: 'BR', question: 'color', action })] });
  render(<AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider>);
}

it('creates a native optional characteristic from its name without a technical key or encoded SKU fields', async () => {
  open();
  fireEvent.change(await screen.findByRole('textbox', { name: /Назва питання/ }), { target: { value: 'Розмір прикраси' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Обовʼязкове' }));
  expect(screen.queryByRole('button', { name: 'Опублікувати V2' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Переіндексувати SKU' })).toBeNull();
  expect(screen.queryByLabelText('Ключ')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][0]).toBe('/admin/question');
  const payload = post.mock.calls[0][1];
  expect(payload).toMatchObject({ category_code: 'BR', label: 'Розмір прикраси', required: 0, input_type: 'options' });
  for (const key of ['key', 'sku_index', 'include_in_sku', 'sku_separator']) expect(payload).not.toHaveProperty(key);
  expect(screen.getByText(/Передавання до Magento потребує окремої перевірки/)).toBeTruthy();
});

it('edits a native label while preserving the existing key and historical encoded parameters exactly', async () => {
  open('edit-question');
  fireEvent.change(await screen.findByRole('textbox', { name: /Назва питання/ }), { target: { value: 'Колір прикраси' } });
  expect(screen.queryByRole('checkbox', { name: 'Додавати значення в SKU' })).toBeNull();
  expect(screen.getByLabelText('Ключ').readOnly).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/admin/question/update', expect.objectContaining({
    id: 84, key: 'color', label: 'Колір прикраси', include_in_sku: 1, sku_index: 2, sku_separator: '-', required: 0,
  })));
});

it('selects the authoritative created question so values and its exact Magento handoff are immediately reachable', async () => {
  const key = 'q_' + 'a'.repeat(32);
  post.mockImplementation(async (url, payload) => {
    if (url !== '/admin/question') throw Error('Unexpected mutation ' + url);
    config = { ...config, questions: { BR: [...config.questions.BR, {
      ...payload, id: key, q_db_id: 85, include_in_sku: 0, sku_index: 0, options: [],
    }] } };
    return { data: { id: 85, key } };
  });
  open();
  fireEvent.change(await screen.findByRole('textbox', { name: /Назва питання/ }), { target: { value: 'Форма прикраси' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  await screen.findByRole('heading', { name: 'Форма прикраси' });
  expect(screen.queryByRole('textbox', { name: /Назва питання/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Додати варіант' }).disabled).toBe(false);
  const link = screen.getByRole('link', { name: 'Підготувати характеристику для Magento' });
  expect(new URL(link.getAttribute('href'), 'http://synthetic.local').searchParams.get('question')).toBe(key);
  expect(post).toHaveBeenCalledTimes(1);
});

it('reveals historical schema controls only by an explicit disclosure and keeps publication separate', async () => {
  open('edit-question');
  await screen.findByRole('textbox', { name: /Назва питання/ });
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/sku-schema/BR'));
  const disclosure = document.querySelector('.catalog-category-context .catalog-history-details');
  expect(disclosure.open).toBe(false);
  fireEvent.click(within(disclosure).getByText('Історичні внутрішні SKU', { selector: 'summary' }));
  const publish = await within(disclosure).findByRole('button', { name: 'Опублікувати V2' });
  expect(publish.disabled).toBe(false);
  expect(within(disclosure).getByText(/не застосовує налаштування Magento/)).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(publish);
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/admin/sku-schema/BR/publish'));
});

it('keeps legacy and unknown-mode SKU controls and editable key contract', async () => {
  delete config.catalogWorkflow;
  config.productCreation = { identityMode: 'public_identity' }; // Other projection is not authoritative for catalog.
  open('edit-question');
  await screen.findByRole('textbox', { name: /Назва питання/ });
  expect(screen.getByRole('checkbox', { name: 'Додавати значення в SKU' }).checked).toBe(true);
  expect(await screen.findByRole('button', { name: 'Опублікувати V2' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Переіндексувати SKU' })).toBeTruthy();
  expect(screen.getByLabelText('Ключ').readOnly).toBe(false);
});

it.each(['legacy', 'native-without-generated-capability'])('preserves explicit new-question keys for %s', async (mode) => {
  if (mode === 'legacy') config.catalogWorkflow = { identityMode: 'encoded_sku', serverGeneratedQuestionKeys: false };
  else config.catalogWorkflow.serverGeneratedQuestionKeys = false;
  open();
  fireEvent.change(await screen.findByRole('textbox', { name: /Назва питання/ }), { target: { value: 'Текст менеджера' } });
  fireEvent.change(screen.getByLabelText('Ключ'), { target: { value: 'manager_key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][1].key).toBe('manager_key');
  if (mode === 'legacy') expect(post.mock.calls[0][1]).toMatchObject({ include_in_sku: 0, sku_index: 0, sku_separator: '' });
});

it('native category edit keeps its stable code and hides only historical branch encoding', async () => {
  open('edit-question');
  await screen.findByRole('textbox', { name: /Назва питання/ });
  const categoryButtons = screen.getAllByRole('button', { name: 'Категорія', exact: true });
  fireEvent.click(categoryButtons[1]);
  expect(screen.getByRole('textbox', { name: /Код категорії/ }).value).toBe('BR');
  expect(screen.getByRole('textbox', { name: /Код категорії/ }).disabled).toBe(true);
  expect(screen.getByRole('checkbox', { name: 'Потрібна вага' }).checked).toBe(true);
  expect(screen.queryByRole('checkbox', { name: 'Пропускати приховані питання в SKU' })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('gates both catalog mutations and exact guided Magento handoff on effective permissions', async () => {
  open('edit-question', ['catalog.view']);
  await screen.findByText('Колір бурштину', { selector: 'strong' });
  expect(screen.queryByRole('textbox', { name: /Назва питання/ })).toBeNull();
  expect(screen.queryByRole('link', { name: /Підготувати.*Magento/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Переіндексувати SKU' })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('links the exact native characteristic to the guided review without executing any command', async () => {
  open('edit-question');
  await screen.findByRole('textbox', { name: /Назва питання/ });
  const link = screen.getByRole('link', { name: 'Підготувати характеристику для Magento' });
  const url = new URL(link.getAttribute('href'), 'http://synthetic.local');
  expect(url.pathname).toBe('/admin/magento/prepare');
  expect(Object.fromEntries(url.searchParams)).toEqual({ category: 'BR', question: 'color', intent: 'attribute' });
  expect(post).not.toHaveBeenCalled();
});
