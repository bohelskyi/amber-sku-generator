import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import AdminPage from '../src/pages/AdminPage.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(['BR', 'NM'])('keeps a filled optional new question intact beside a long %s question list and saves only on explicit action', async (code) => {
  const questions = Array.from({ length: 30 }, (_, index) => ({ id: 'field' + index, q_db_id: index + 1, label: 'Питання ' + (index + 1),
    input_type: 'options', options: [], required: 0, include_in_sku: 0, display_order: index + 1, visible_if_json: '', archived: false }));
  const config = { categories: { [code]: { code, name: code === 'BR' ? 'Браслети' : 'Намисто', requires_weight: 1 } }, questions: { [code]: questions }, extraConfig: {} };
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/admin/config') return { data: config };
    if (url === '/admin/sku-schema/' + code) return { data: { active: null, draftChanged: false } };
    throw new Error('Unexpected fixture read: ' + url);
  });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { success: true } });
  const router = createMemoryRouter([{ path: '*', element: <AdminPage mode="catalog" /> }], { initialEntries: ['/admin/catalog?category=' + code + '&action=new-question'] });
  render(<AuthContext.Provider value={{ permissions: ['catalog.view', 'catalog.manage'], roles: [], principalLifetime: { valid: true } }}><RouterProvider router={router} /></AuthContext.Provider>);
  fireEvent.change(await screen.findByRole('textbox', { name: 'Назва питання' }), { target: { value: 'TEST layout optional' } });
  const required = screen.getByRole('checkbox', { name: 'Обовʼязкове' }); if (required.checked) fireEvent.click(required);
  fireEvent.click(screen.getByText('Технічні параметри'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Ключ' }), { target: { value: 'test_layout_optional' } });
  expect(screen.getByRole('textbox', { name: 'Назва питання' }).value).toBe('TEST layout optional');
  expect(screen.getByRole('textbox', { name: 'Ключ' }).value).toBe('test_layout_optional');
  expect(required.checked).toBe(false); expect(screen.getByText('Питання 30')).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти питання' }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post.mock.calls[0][0]).toBe('/admin/question');
  expect(post.mock.calls[0][1]).toMatchObject({ category_code: code, key: 'test_layout_optional', label: 'TEST layout optional', required: 0 });
  expect(get).toHaveBeenCalledWith('/admin/config');
});
