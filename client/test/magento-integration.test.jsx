import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoIntegrationPage from '../src/pages/MagentoIntegrationPage.jsx';
vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(cleanup);
const category = (code, name, prep = false, count = 0) => ({ code, name, operational: { state: 'known', count, reasons: [] },
  preparation: { needed: prep, count: prep ? 1 : 0, reasons: prep ? [{ code: 'NOT_CONNECTED', count: 1, message: 'Ще не підключено' }] : [] }, impact: 'unexamined' });
const data = { integration: { configured: true, activePublication: { id: 'published', revision: '8', versionNumber: 3, publishedAt: '2026-10-01T12:00:00Z' },
  delivery: { state: 'enabled' }, operational: { state: 'known', count: 0 }, structureObservation: { observedAt: '2026-01-01T12:00:00Z', bindingId: 'published', state: 'published' },
  draftCount: 1, asOf: '2026-10-02T12:00:00Z' }, categories: [category('OK', 'Готова категорія'), category('XX', 'Нова категорія', true)] };
const shell = (path = '/admin/magento', permissions = ['export_templates.view', 'products.view'], roles = []) => render(
  <AuthContext.Provider value={{ permissions, roles }}><MemoryRouter initialEntries={[path]}><Routes><Route path="/admin/magento/*" element={<MagentoIntegrationPage />} /></Routes></MemoryRouter></AuthContext.Provider>);
beforeEach(() => { vi.resetAllMocks(); api.get.mockResolvedValue({ data }); });

it('separates active delivery from future preparation and loads only the lightweight overview', async () => {
  shell(); await screen.findByText('Автоматичну синхронізацію увімкнено');
  expect(screen.getByText('Зафіксованих проблем немає')).toBeTruthy();
  expect(screen.getByText('Версія 3')).toBeTruthy();
  expect(screen.getByText('Ще не підключено')).toBeTruthy();
  expect(screen.queryByText('Готова категорія')).toBeNull();
  expect(screen.queryByText('Категорія ще не готова до Magento')).toBeNull();
  expect(screen.queryByText('Редактор відповідностей ще недоступний')).toBeNull();
  expect(api.get.mock.calls.map(([path]) => path)).toEqual(['/admin/magento-integration/overview']);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('link', { name: 'Усі категорії' }));
  expect(await screen.findByRole('link', { name: 'Готова категорія' })).toBeTruthy();
});

it('discovery is explicit and failed checks retain the prior factual observation without age warnings', async () => {
  shell(); await screen.findByText('Версія 3');
  const stored = screen.getByText(/Остання перевірка структури Magento:/).textContent;
  expect(stored).not.toContain('02.10.26');
  api.post.mockRejectedValueOnce({ response: { data: { error: 'Magento недоступний' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити Magento' }));
  await screen.findByText('Magento недоступний');
  expect(screen.getByText(/Остання перевірка структури Magento:/).textContent).toBe(stored);
  expect(screen.getByText('Зафіксованих проблем немає')).toBeTruthy();
  expect(screen.queryByText(/застаріл|7 днів/i)).toBeNull();
  api.post.mockResolvedValueOnce({ data: { observedAt: '2026-10-02T14:32:00Z', schema: { attributes: [] }, categories: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити Magento' }));
  await screen.findByText(/Явна перевірка в цьому сеансі/);
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/discovery', {}], ['/admin/magento-integration/discovery', {}]]);
});

it('does not turn unknown evidence into zero problems or Administrator authority', async () => {
  api.get.mockResolvedValue({ data: { ...data, integration: { ...data.integration, delivery: { state: 'unknown' }, operational: { state: 'unavailable', count: null } } } });
  shell('/admin/magento', ['export_templates.view', 'export_templates.manage', 'export_templates.publish']);
  await screen.findByText('Стан автоматичної синхронізації невідомий');
  expect(screen.getByText('Дані про зафіксовані проблеми недоступні')).toBeTruthy();
  expect(screen.queryByText('Зафіксованих проблем немає')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Дії Адміністратора' })).toBeNull();
  expect(screen.getAllByRole('link', { name: 'Підготувати зміни інтеграції' }).length).toBeGreaterThan(0);
});

it('mounts only issue rows and pages all mappings on demand', async () => {
  const values = Array.from({ length: 240 }, (_, i) => ({ questionKey: 'kind', questionLabel: 'Вид', valueId: String(i), label: `Готове значення ${i}`, state: i % 2 ? 'approved' : 'not_applicable', mappings: [] }));
  values.push({ questionKey: 'kind', questionLabel: 'Вид', valueId: 'missing', label: 'Потрібне значення', state: 'missing', mappings: [] });
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/overview') ? data : { categories: [{ code: 'XX', values }] } }));
  shell('/admin/magento/categories/XX');
  await screen.findByText('Вид: Потрібне значення');
  expect(screen.queryByText(/Готове значення/)).toBeNull();
  expect(screen.queryByText(/value_id:/)).toBeNull();
  const mappings = screen.getByRole('heading', { name: 'Відповідності категорії' }).closest('section');
  expect(mappings.querySelectorAll('article')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Показати всі відповідності' }));
  expect(mappings.querySelectorAll('article')).toHaveLength(50);
  expect(within(mappings).getByText('1 / 5')).toBeTruthy();
});

it('late local overview responses cannot overwrite a newer refresh', async () => {
  let resolveOld;
  api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ data });
  shell(); fireEvent.click(screen.getByRole('button', { name: 'Оновити стан' }));
  await screen.findByText('Версія 3');
  await act(async () => resolveOld({ data: { ...data, integration: { ...data.integration, activePublication: null } } }));
  expect(screen.getByText('Версія 3')).toBeTruthy();
});
