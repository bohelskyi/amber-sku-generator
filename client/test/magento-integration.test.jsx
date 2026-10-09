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
const shell = (path = '/admin/magento/overview', permissions = ['export_templates.view', 'products.view'], roles = []) => render(
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
  expect(await screen.findByRole('link', { name: /Готова категорія/ })).toBeTruthy();
});

it('discovery is explicit and failed checks retain the prior factual observation without age warnings', async () => {
  shell(); await screen.findByText('Версія 3');
  const stored = screen.getByText(/Остання перевірка структури Magento:/).textContent;
  expect(stored).not.toContain('02.10.26');
  api.post.mockRejectedValueOnce({ response: { data: { error: 'Magento недоступний' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити структуру' }));
  await screen.findByText('Magento недоступний');
  expect(screen.getByText(/Остання перевірка структури Magento:/).textContent).toBe(stored);
  expect(screen.getByText('Зафіксованих проблем немає')).toBeTruthy();
  expect(screen.queryByText(/застаріл|7 днів/i)).toBeNull();
  api.post.mockResolvedValueOnce({ data: { observedAt: '2026-10-02T14:32:00Z', schema: { attributes: [] }, categories: [] } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити структуру' }));
  await screen.findByText(/Явна перевірка в цьому сеансі/);
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/structure-check', {}], ['/admin/magento-integration/structure-check', {}]]);
});

it('does not turn unknown evidence into zero problems or Administrator authority', async () => {
  api.get.mockResolvedValue({ data: { ...data, integration: { ...data.integration, delivery: { state: 'unknown' }, operational: { state: 'unavailable', count: null } } } });
  shell('/admin/magento', ['export_templates.view', 'export_templates.manage', 'export_templates.publish']);
  await screen.findByText('Стан автоматичної синхронізації невідомий');
  expect(screen.getByText('Дані про зафіксовані проблеми недоступні')).toBeTruthy();
  expect(screen.queryByText('Зафіксованих проблем немає')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Дії Адміністратора' })).toBeNull();
  fireEvent.click(screen.getByText('Інші розділи'));
  expect(screen.getByRole('link', { name: 'Підготовлені зміни' })).toBeTruthy();
});

it('mounts only issue rows; all mappings start collapsed and page an opened group', async () => {
  const values = Array.from({ length: 240 }, (_, i) => ({ questionKey: 'kind', questionLabel: 'Вид', valueId: String(i), label: `Готове значення ${i}`, state: i % 2 ? 'approved' : 'not_applicable', mappings: [] }));
  values.push({ questionKey: 'kind', questionLabel: 'Вид', valueId: 'missing', label: 'Потрібне значення', state: 'missing', mappings: [] });
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/overview') ? data : { categories: [{ code: 'XX', values }] } }));
  shell('/admin/magento/categories/XX?tab=legacy');
  await screen.findByText('Вид: Потрібне значення');
  expect(screen.queryByText(/Готове значення/)).toBeNull();
  expect(screen.queryByText(/value_id:/)).toBeNull();
  const mappings = screen.getByRole('heading', { name: 'Відповідності категорії' }).closest('section');
  expect(mappings.querySelectorAll('article')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Показати всі відповідності' }));
  expect(mappings.querySelectorAll('article')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Вид · kind · 241' }));
  expect(mappings.querySelectorAll('article')).toHaveLength(50);
  expect(within(mappings).getByText('1 / 5')).toBeTruthy();
  fireEvent.click(within(mappings).getByRole('button', { name: 'Далі' }));
  expect(screen.getByText('Вид: Готове значення 50')).toBeTruthy();
  expect(mappings.querySelectorAll('article')).toHaveLength(50);
  expect(screen.queryByText(/value_id:/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Вид · kind · 241' }));
  expect(mappings.querySelectorAll('article')).toHaveLength(0);
  expect(api.post).not.toHaveBeenCalled();
});

const stone = { questionKey: 'stone_processing', questionLabel: 'Який камінь?', valueId: '0', skuCode: '0',
  label: 'Не оброблений камінь', state: 'approved', mappings: [{ routeKey: 'SV.souvenir=value_id:5', attribute: 'kamin_obrobka', optionId: '6040', optionLabel: 'Необроблений' }] };
function mappingFixture(values) {
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/overview') ? data : { categories: [{ code: 'XX', values }] } }));
}

it.each(['Не оброблений камінь', 'Який камінь?', 'stone_processing', 'kamin_obrobka'])('searches the entire mapping scope by %s without mounting unrelated rows', async (search) => {
  mappingFixture([...Array.from({ length: 240 }, (_, i) => ({ ...stone, questionKey: `color${i}`, questionLabel: 'Колір', label: `Колір ${i}`, mappings: [] })), stone]);
  shell('/admin/magento/categories/XX?tab=legacy');
  await screen.findByText(/Немає невирішених/);
  fireEvent.click(screen.getByRole('button', { name: 'Показати всі відповідності' }));
  expect(document.querySelectorAll('article')).toHaveLength(0);
  expect(within(screen.getByRole('heading', { name: 'Відповідності категорії' }).closest('section')).getAllByRole('button', { expanded: false })).toHaveLength(20);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Пошук відповідностей' }), { target: { value: search } });
  expect(within(screen.getByRole('heading', { name: 'Відповідності категорії' }).closest('section')).getAllByRole('button', { expanded: false })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Який камінь? · stone_processing → kamin_obrobka · 1' }));
  expect(screen.getByText('Який камінь?: Не оброблений камінь')).toBeTruthy();
  expect(document.querySelectorAll('article')).toHaveLength(1);
  expect(screen.queryByText(/value_id:/)).toBeNull();
  fireEvent.click(within(document.querySelector('article')).getByText('Технічні деталі'));
  expect(screen.getByText(/Magento ID 6040/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

it('a field deep link filters approved mappings, keeps groups collapsed and lets the operator clear context', async () => {
  mappingFixture([stone, { ...stone, questionKey: 'color', questionLabel: 'Колір', label: 'Світлий', mappings: [{ attribute: 'kolir' }] }]);
  shell('/admin/magento/categories/XX?field=kamin_obrobka&tab=legacy');
  await screen.findByText('kamin_obrobka');
  expect(screen.getByRole('button', { name: 'Показати лише питання' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(screen.getByRole('heading', { name: 'Відповідності категорії' }).closest('section')).getAllByRole('button', { expanded: false })).toHaveLength(1);
  expect(document.querySelectorAll('article')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Зняти фільтр поля' }));
  expect(within(screen.getByRole('heading', { name: 'Відповідності категорії' }).closest('section')).getAllByRole('button', { expanded: false })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Показати лише питання' }));
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.queryByText('Світлий')).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('late local overview responses cannot overwrite a newer refresh', async () => {
  let resolveOld;
  api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue({ data });
  shell(); fireEvent.click(screen.getByRole('button', { name: 'Оновити стан' }));
  await screen.findByText('Версія 3');
  await act(async () => resolveOld({ data: { ...data, integration: { ...data.integration, activePublication: null } } }));
  expect(screen.getByText('Версія 3')).toBeTruthy();
});

it('on focus refreshes only local integration counters and never performs a remote check', async () => {
  api.get.mockResolvedValue({ data }); shell('/admin/magento');
  await screen.findByText('Автоматичну синхронізацію увімкнено');
  const before = api.get.mock.calls.filter(([url]) => url === '/admin/magento-integration/overview').length;
  fireEvent(window, new Event('focus'));
  await vi.waitFor(() => expect(api.get.mock.calls.filter(([url]) => url === '/admin/magento-integration/overview').length).toBe(before + 1));
  expect(api.post).not.toHaveBeenCalled();
});
