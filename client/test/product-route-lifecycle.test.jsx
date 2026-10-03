import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import AppPage from '../src/pages/AppPage.jsx';
import { api } from '../src/lib/api.js';

const config = {
  categories: { SV: { code: 'SV', name: 'Сувеніри', requires_weight: 0 } },
  questions: { SV: [] },
  extraConfig: {},
};
const decoded = {
  existsInDb: true,
  sku: 'SV-INTERNAL-91',
  internalSku: 'SV-INTERNAL-91',
  publicSku: 'AG-000091',
  category: config.categories.SV,
  decodedAnswers: [],
  skuSchema: { version: 1, marker: '' },
  suffix: { type: 'sequence', value: 91, raw: '91' },
  baseSku: 'SV',
  product: { id: 91, status: 'active', details: {} },
  pricing: null,
};

function RoutedProductWorkspace() {
  return <AuthContext.Provider value={{
    permissions: ['products.view', 'products.decode'],
    roles: [],
    principalLifetime: { valid: true },
  }}>
    <Link to="/products">Товари навігація</Link>
    <AppPage />
  </AuthContext.Provider>;
}

beforeEach(() => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/config') return { data: config };
    if (url === '/magento/product-status/91') return { data: { state: 'not_queued' } };
    return { data: {} };
  });
  vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/decode') return { data: decoded };
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('clears an opened product after accepted navigation back to the Products landing', async () => {
  const router = createMemoryRouter([{ path: '*', element: <RoutedProductWorkspace /> }], {
    initialEntries: ['/products/open?article=AG-000091'],
  });
  render(<RouterProvider router={router} />);

  expect(await screen.findByText('AG-000091')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Товар AG-000091' })).toBeTruthy();
  expect(api.post).toHaveBeenCalledWith('/decode', { sku: 'AG-000091' });
  fireEvent.click(screen.getByRole('link', { name: 'Товари навігація' }));

  await waitFor(() => expect(router.state.location.pathname).toBe('/products'));
  expect(await screen.findByRole('heading', { name: 'Знайти за артикулом' })).toBeTruthy();
  expect(screen.queryByText('AG-000091')).toBeNull();
});

it('returns from the public article context to the same filtered register address', async () => {
  const router = createMemoryRouter([{ path: '*', element: <RoutedProductWorkspace /> }], {
    initialEntries: [{ pathname: '/products/open', search: '?article=AG-000091', state: {
      productReturnTo: '/products?search=AG&category=SV&cursor=opaque&page=2',
      productReturnState: { productRegisterBack: [null] },
    } }],
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole('heading', { level: 1, name: 'Товар AG-000091' });
  fireEvent.click(screen.getByRole('link', { name: 'Повернутися до реєстру' }));
  await waitFor(() => expect(router.state.location.search).toBe('?search=AG&category=SV&cursor=opaque&page=2'));
  expect(router.state.location.state.productRegisterBack).toEqual([null]);
});
