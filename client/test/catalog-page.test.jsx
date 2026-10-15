import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import CatalogPage from '../src/pages/CatalogPage.jsx';

vi.mock('../src/components/workspace/MagentoCategoryWorkspace.jsx', () => ({ default: ({ categories, localConfig, integrationAvailable, onLocalSaved, onPublished }) => <section>
  <output aria-label="Категорії">{JSON.stringify(categories)}</output>
  <output aria-label="Локальні дані">{localConfig ? 'є' : 'немає'}</output>
  <output aria-label="Магазин">{integrationAvailable ? 'доступний' : 'недоступний'}</output>
  <button onClick={() => void onLocalSaved()}>Оновити після збереження</button>
  <button onClick={onPublished}>Оновити магазин</button>
</section> }));
vi.mock('../src/components/workspace/MagentoPreparationWorkspace.jsx', () => ({ default: ({ embedded }) => <h2>{embedded ? 'Вбудоване налаштування' : 'Окреме налаштування'}</h2> }));
let config, get;
beforeEach(() => {
  config = { categories: { BR: { code: 'BR', name: 'Браслети' } }, questions: { BR: [] } };
  get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return { data: config };
    if (url === '/admin/magento-integration/overview') return { data: { categories: [{ code: 'BR', name: 'Old name', unboundCount: 3, operational: { count: 2 } }], integration: { activePublication: { id: 'active' } } } };
    throw Error('Unexpected read ' + url);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open(permissions, path = '/admin/catalog?category=BR') {
  const router = createMemoryRouter([{ path: '*', element: <CatalogPage /> }], { initialEntries: [path] });
  render(<AuthContext.Provider value={{ permissions, roles: [] }}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
it('reads catalog without requiring integration capabilities or making integration requests', async () => {
  open(['catalog.view']);
  await waitFor(() => expect(screen.getByLabelText('Локальні дані').textContent).toBe('є'));
  expect(get).toHaveBeenCalledExactlyOnceWith('/admin/config');
  expect(screen.getByLabelText('Магазин').textContent).toBe('недоступний');
});
it('does not require or fetch the local catalog for integration-only readers', async () => {
  open(['export_templates.view']);
  await waitFor(() => expect(screen.getByLabelText('Магазин').textContent).toBe('доступний'));
  expect(get.mock.calls.map(([url]) => url)).toEqual(['/admin/magento-integration/overview']);
  expect(screen.getByLabelText('Локальні дані').textContent).toBe('немає');
});
it('keeps local category work available after integration overview failure', async () => {
  get.mockImplementation(async (url) => {
    if (url === '/admin/config') return { data: config };
    throw Error('Magento is unavailable');
  });
  open(['catalog.view', 'export_templates.view']);
  await screen.findByText('Налаштування магазину недоступні');
  expect(screen.getByLabelText('Локальні дані').textContent).toBe('є');
  expect(JSON.parse(screen.getByLabelText('Категорії').textContent)[0].code).toBe('BR');
});
it.each(['/admin/config', '/admin/magento-integration/overview'])('waits for the initial authorized %s read before mounting editable workspace', async (delayedUrl) => {
  const initialGet = get.getMockImplementation();
  let resolveRead;
  get.mockImplementation((url, ...args) => url === delayedUrl
    ? new Promise((resolve) => { resolveRead = resolve; })
    : initialGet(url, ...args));
  open(['catalog.view', 'export_templates.view']);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(screen.queryByLabelText('Категорії')).toBeNull();
  await act(async () => { resolveRead(await initialGet(delayedUrl)); });
  await waitFor(() => expect(screen.getByLabelText('Магазин').textContent).toBe('доступний'));
  expect(screen.getByLabelText('Локальні дані').textContent).toBe('є');
});
it('keeps the existing workspace mounted when a later integration refresh fails', async () => {
  open(['catalog.view', 'export_templates.view']);
  await waitFor(() => expect(screen.getByLabelText('Магазин').textContent).toBe('доступний'));
  const existingWorkspace = screen.getByLabelText('Категорії').parentElement;
  get.mockRejectedValueOnce(Error('Refresh failed'));
  fireEvent.click(screen.getByRole('button', { name: 'Оновити магазин' }));
  await screen.findByText('Налаштування магазину недоступні');
  expect(screen.getByLabelText('Категорії').parentElement).toBe(existingWorkspace);
  expect(screen.getByLabelText('Магазин').textContent).toBe('доступний');
});
it('merges by exact category code and refreshes saved local names without losing integration evidence', async () => {
  open(['catalog.view', 'export_templates.view']);
  await waitFor(() => expect(screen.getByLabelText('Магазин').textContent).toBe('доступний'));
  expect(JSON.parse(screen.getByLabelText('Категорії').textContent)).toEqual([expect.objectContaining({ code: 'BR', name: 'Браслети', unboundCount: 3, operational: { count: 2 } })]);
  config = { ...config, categories: { BR: { code: 'BR', name: 'Нові браслети' } } };
  fireEvent.click(screen.getByRole('button', { name: 'Оновити після збереження' }));
  await waitFor(() => expect(JSON.parse(screen.getByLabelText('Категорії').textContent)[0].name).toBe('Нові браслети'));
});
it('embeds the explicit resource task instead of mounting a second category editor', async () => {
  open(['catalog.view', 'export_templates.view', 'export_templates.manage'], '/admin/catalog?category=BR&catalogTask=resource&intent=attribute');
  await screen.findByRole('heading', { name: 'Вбудоване налаштування' });
  expect(screen.queryByLabelText('Категорії')).toBeNull();
});
it('returns to the exact newly saved category even if refreshing the workspace fails', async () => {
  config.catalogWorkflow = { identityMode: 'public_identity', serverGeneratedQuestionKeys: true };
  const post = vi.spyOn(api, 'post').mockImplementation(async () => {
    get.mockRejectedValue(Error('Refresh failed'));
    return { data: { id: 'NEW', name: 'Нова категорія' } };
  });
  const router = open(['catalog.view', 'catalog.manage'], '/admin/catalog?category=BR&action=new-category');
  fireEvent.change(await screen.findByRole('textbox', { name: /Код категорії/ }), { target: { value: 'new' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Нова категорія' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  await screen.findByText('Категорію збережено, але робочий простір не оновлено');
  fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
  await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('category')).toBe('NEW'));
  expect(new URLSearchParams(router.state.location.search).has('action')).toBe(false);
  expect(post).toHaveBeenCalledTimes(1);
});
