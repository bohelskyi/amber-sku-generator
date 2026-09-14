import { MemoryRouter } from 'react-router-dom';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AdminPage from '../src/pages/AdminPage.jsx';

const category = {
  code: 'BR', name: 'Bracelets', requires_weight: 0,
  skip_hidden_sku_questions: 0, marketing_rounding_enabled: 1,
};
const config = { categories: { BR: category }, questions: { BR: [] }, extraConfig: {} };
const response = (data) => ({ data, status: 200 });

function renderAdmin() {
  render(
    <AuthContext.Provider value={{
      identity: { name: 'Admin' }, applicationUser: { id: 1, status: 'active' },
      permissions: ['catalog.view', 'catalog.manage'], roles: [],
      logout: vi.fn(), refresh: vi.fn(),
    }}>
      <MemoryRouter><AdminPage /></MemoryRouter>
    </AuthContext.Provider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('submits the enabled default when creating a category', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(response(config));
  const post = vi.spyOn(api, 'post').mockResolvedValue(response({ id: 'NEW' }));
  renderAdmin();
  await screen.findByRole('tab', { name: /Bracelets/ });
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[0]);
  const rounding = screen.getByLabelText('Маркетингове округлення автоматичних цін');
  expect(rounding.checked).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Код' }), { target: { value: 'NEW' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'New category' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/category', expect.objectContaining({
    code: 'NEW', marketing_rounding_enabled: 1,
  })));
});

it('submits zero when creating a category with rounding unchecked', async () => {
  vi.spyOn(api, 'get').mockResolvedValue(response(config));
  const post = vi.spyOn(api, 'post').mockResolvedValue(response({ id: 'EXACT' }));
  renderAdmin();
  await screen.findByRole('tab', { name: /Bracelets/ });
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[0]);
  const rounding = screen.getByLabelText('Маркетингове округлення автоматичних цін');
  fireEvent.click(rounding);
  expect(rounding.checked).toBe(false);
  fireEvent.change(screen.getByRole('textbox', { name: 'Код' }), { target: { value: 'EXACT' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Назва' }), { target: { value: 'Exact prices' } });
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти категорію' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/category', expect.objectContaining({
    code: 'EXACT', marketing_rounding_enabled: 0,
  })));
});

it('loads and submits the category rounding choice', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return response(config);
    if (url === '/admin/sku-schema/BR') return response({ active: null, draftChanged: false });
    if (url === '/admin/prices/BR') return response({ scenarios: [], modifiers: [] });
    throw new Error(`Unexpected GET ${url}`);
  });
  const put = vi.spyOn(api, 'put').mockResolvedValue(response({ success: true, code: 'BR' }));
  renderAdmin();
  fireEvent.click(await screen.findByRole('tab', { name: /Bracelets/ }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Категорія', exact: true })[1]);
  const rounding = screen.getByLabelText('Маркетингове округлення автоматичних цін');
  expect(rounding.checked).toBe(true);
  fireEvent.click(rounding);
  expect(rounding.checked).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/category', expect.objectContaining({
    code: 'BR', marketing_rounding_enabled: 0,
  })));
});
