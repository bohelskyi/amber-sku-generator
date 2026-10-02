import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoIntegrationPage from '../src/pages/MagentoIntegrationPage.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(cleanup);
const data = { configured: true, revision: null, revisions: [], limitations: ['Лише структурна перевірка.'],
  categories: [{ code: 'XX', name: 'Нова категорія', schema: null, ready: false, routes: [],
    message: 'Категорія ще не готова до Magento', values: [{ questionKey: 'kind', questionLabel: 'Вид', valueId: '8', label: 'Скриньки', state: 'missing', mappings: [] }] }],
  products: [{ category: 'XX', total: 10, checked: 0, evaluated: 0, blocked: 0, unexamined: 10, remoteChecked: 0 }], catalog: { questions: {} } };
const shell = (permissions = ['export_templates.view']) => render(<AuthContext.Provider value={{ permissions }}><MemoryRouter><MagentoIntegrationPage /></MemoryRouter></AuthContext.Provider>);
beforeEach(() => { vi.resetAllMocks(); api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/actions') ? [] : data })); });
it('shows future category readiness and unexamined products without silently claiming sendability', async () => {
  shell(); await screen.findByText('Категорія ще не готова до Magento');
  expect(screen.getByText(/не перевірено: 10/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Перевірити приклад CREATE' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
it('discovery is explicit, has a retryable failure state and does not write or approve', async () => {
  shell(); await screen.findByText('Категорія ще не готова до Magento');
  api.post.mockRejectedValueOnce({ response: { data: { error: 'Magento недоступний' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити структуру Magento' }));
  await screen.findByText('Magento недоступний');
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/magento-integration/discovery', {});
  expect(screen.getByRole('button', { name: 'Перевірити структуру Magento' }).disabled).toBe(false);
});
it('changing binding context removes old actions until the selected snapshot arrives', async () => {
  const revisions = [{ id: 'next-draft', state: 'draft', revision: '2', observed_at: '2026-10-02T00:00:00Z' }];
  let resolveNext;
  api.get.mockImplementation((path, options) => {
    if (path.endsWith('/actions')) return Promise.resolve({ data: [] });
    if (options?.params?.bindingRevisionId === 'next-draft') return new Promise((resolve) => { resolveNext = resolve; });
    return Promise.resolve({ data: { ...data, revisions } });
  });
  shell(); await screen.findByRole('button', { name: 'Нова категорія' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Версія відповідностей' }), { target: { value: 'next-draft' } });
  expect(screen.queryByRole('button', { name: 'Нова категорія' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Перевірити структуру Magento' })).toBeNull();
  await act(async () => resolveNext({ data: { ...data, revisions,
    categories: [{ ...data.categories[0], name: 'Категорія наступної версії' }] } }));
  expect(screen.getByRole('button', { name: 'Категорія наступної версії' })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
