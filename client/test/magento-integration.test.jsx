import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data }); });
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
