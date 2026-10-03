import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { AppShell } from '../src/components/app/AppShell.jsx';
import { Workspace } from '../src/router.jsx';

const adminRender = vi.hoisted(() => vi.fn(({ mode }) => <h1>{mode}</h1>));
vi.mock('../src/pages/AppPage.jsx', () => ({ default: () => <h1>Товари</h1> }));
vi.mock('../src/pages/AdminPage.jsx', () => ({ default: adminRender }));
vi.mock('../src/pages/CorrectionHistoryPage.jsx', () => ({ default: () => <h1>Історія товарів</h1> }));
vi.mock('../src/pages/ExportsPage.jsx', () => ({ default: () => <h1>Історичний експорт</h1> }));
vi.mock('../src/api/exports-api.js', () => ({ exportsApi: {
  getStatus: vi.fn().mockResolvedValue({ data: { delivery: { legacyProductCsvEnabled: false } } }),
  getPriceStatus: vi.fn().mockResolvedValue({ data: { pendingCount: 0 } }),
} }));

const auth = (permissions) => ({
  permissions, identity: { name: 'Оператор' }, roles: [], logout: vi.fn(), principalLifetime: { valid: true },
});
function mount(path, permissions) {
  const router = createMemoryRouter([{ path: '*', element: <Workspace /> }], { initialEntries: [path] });
  render(<AuthContext.Provider value={auth(permissions)}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
afterEach(() => { cleanup(); adminRender.mockClear(); vi.restoreAllMocks(); });

it('exposes legacy export only in the account menu with its existing permission', async () => {
  render(<AuthContext.Provider value={auth(['products.view', 'exports.view'])}><MemoryRouter>
    <AppShell><h1>Товари</h1></AppShell>
  </MemoryRouter></AuthContext.Provider>);
  expect(screen.queryByRole('link', { name: 'Експорт', exact: true })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Історичний експорт' })).toBeNull();
  expect(document.querySelector('.app-navigation a[href="/exports"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Обліковий запис: Оператор' }));
  expect((await screen.findByRole('link', { name: 'Історичний експорт' })).getAttribute('href')).toBe('/exports');
  cleanup();
  render(<AuthContext.Provider value={auth(['products.view'])}><MemoryRouter>
    <AppShell><h1>Товари</h1></AppShell>
  </MemoryRouter></AuthContext.Provider>);
  fireEvent.click(screen.getByRole('button', { name: 'Обліковий запис: Оператор' }));
  await screen.findByRole('button', { name: 'Вийти' });
  expect(screen.queryByRole('link', { name: 'Історичний експорт' })).toBeNull();
});

it('preserves a secondary root fallback and export deep links for export-only users', async () => {
  const router = mount('/', ['exports.view']);
  await screen.findByRole('heading', { name: 'Історичний експорт' });
  expect(router.state.location.pathname).toBe('/exports');
  expect(document.querySelectorAll('.app-navigation-link')).toHaveLength(0);
  cleanup();
  const deep = mount('/exports/history/price/stored-result?after=retained', ['exports.view']);
  await screen.findByRole('heading', { name: 'Історичний експорт' });
  expect(deep.state.location.pathname).toBe('/exports/history/price/stored-result');
  expect(deep.state.location.search).toBe('?after=retained');
});

it('keeps current Magento template configuration independent of legacy export access', async () => {
  mount('/settings', ['pricing.view', 'export_templates.view']);
  await screen.findByRole('heading', { name: 'Налаштування' });
  expect(screen.getByRole('link', { name: /^Ціноутворення/ }).getAttribute('href')).toBe('/admin/pricing');
  expect(screen.getByRole('link', { name: /^Шаблони інтеграції/ }).getAttribute('href')).toBe('/admin/export-templates');
  expect(screen.getByRole('link', { name: /^Інтеграція Magento/ }).getAttribute('href')).toBe('/admin/magento');
  expect(document.querySelector('.workspace-directory a[href="/exports"]')).toBeNull();
  expect(screen.queryByRole('link', { name: /Історичний експорт/ })).toBeNull();
});

it('keeps legacy product links while enforcing the independent decode boundary', async () => {
  const decodeRouter = mount('/?article=AG-000042', ['products.decode']);
  await screen.findByRole('heading', { name: 'Товари' });
  expect(decodeRouter.state.location.pathname).toBe('/products/open');
  expect(decodeRouter.state.location.search).toBe('?article=AG-000042');
  cleanup();
  const viewRouter = mount('/?exportSku=SV-EXACT', ['products.view']);
  await screen.findByRole('heading', { name: 'Товари' });
  expect(viewRouter.state.location.pathname).toBe('/products');
  expect(viewRouter.state.location.search).toBe('?exportSku=SV-EXACT');
});

it('routes history.view directly to the product register history alias', async () => {
  const router = mount('/products/history', ['history.view']);
  await screen.findByRole('heading', { name: 'Історія товарів' });
  expect(router.state.location.pathname).toBe('/products/history');
  expect(screen.getByRole('link', { name: 'Товари' }).getAttribute('aria-current')).toBe('page');
});

it('interprets the legacy configuration hash before mounting one keyed workspace', async () => {
  const router = mount('/admin?category=BR#catalog-pricing', ['catalog.view', 'pricing.view']);
  await screen.findByRole('heading', { name: 'pricing' });
  await waitFor(() => expect(router.state.location.pathname).toBe('/admin/pricing'));
  expect(router.state.location.search).toBe('?category=BR');
  expect(router.state.location.hash).toBe('');
  expect(adminRender).toHaveBeenCalledOnce();
  expect(adminRender.mock.calls[0][0].mode).toBe('pricing');
});

it('moves focus to the page heading after a pathname change only', async () => {
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const element = <AppShell><Routes>
    <Route path="/first" element={<><Link to="/second">Наступна сторінка</Link><h1>Перша сторінка</h1></>} />
    <Route path="/second" element={<h1>Друга сторінка</h1>} />
  </Routes></AppShell>;
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: ['/first?query=kept'] });
  render(<AuthContext.Provider value={auth(['products.view'])}><RouterProvider router={router} /></AuthContext.Provider>);
  const first = await screen.findByRole('heading', { name: 'Перша сторінка' });
  expect(document.activeElement).not.toBe(first);
  fireEvent.click(screen.getByRole('link', { name: 'Наступна сторінка' }));
  const second = await screen.findByRole('heading', { name: 'Друга сторінка' });
  await waitFor(() => expect(document.activeElement).toBe(second));
  expect(second.tabIndex).toBe(-1);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' });
});
