import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { Workspace } from '../src/router.jsx';

const adminRender = vi.hoisted(() => vi.fn(({ mode }) => <h1>{mode}</h1>));
vi.mock('../src/pages/AppPage.jsx', () => ({ default: () => <h1>Товари</h1> }));
vi.mock('../src/pages/AdminPage.jsx', () => ({ default: adminRender }));
vi.mock('../src/pages/CorrectionHistoryPage.jsx', () => ({ default: () => <h1>Історія товарів</h1> }));

const auth = (permissions) => ({
  permissions, identity: { name: 'Оператор' }, roles: [], logout: vi.fn(), principalLifetime: { valid: true },
});
function mount(path, permissions) {
  const router = createMemoryRouter([{ path: '*', element: <Workspace /> }], { initialEntries: [path] });
  render(<AuthContext.Provider value={auth(permissions)}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
afterEach(() => { cleanup(); adminRender.mockClear(); });

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
