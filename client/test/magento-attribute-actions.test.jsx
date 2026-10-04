import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import { api } from '../src/lib/api.js';
import MagentoAttributeActions from '../src/components/workspace/MagentoAttributeActions.jsx';

vi.mock('../src/lib/api.js', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const revision = { id: 'draft', revision: '7', state: 'draft', bindings: { routes: [
  { routeKey: 'BR:all', enabled: true, reviewState: 'approved', setId: 142 },
] }, schema: { attributes: [
  { attribute_code: 'color', default_frontend_label: 'Колір', is_user_defined: true, frontend_input: 'select' },
  { attribute_code: 'price', default_frontend_label: 'Ціна', is_user_defined: false, frontend_input: 'text' },
] } };
const context = { sets: [{ id: 142, name: 'Браслети' }], set: { id: 142, name: 'Браслети' }, englishStoreId: 3,
  groups: [{ id: 19, name: 'Характеристики', setId: 142 }], members: [] };
const auth = { roles: [{ key: 'administrator' }], permissions: ['export_templates.view', 'export_templates.manage', 'export_templates.publish'] };
beforeEach(() => {
  vi.resetAllMocks();
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/actions') ? [] : context }));
});
afterEach(cleanup);
function shell(props = {}, user = auth) {
  const router = createMemoryRouter([{ path: '/', element: <><Link to="/other">Інша сторінка</Link><MagentoAttributeActions revision={revision} categoryCode="BR" {...props} /></> }, { path: '/other', element: <p>Інша робота</p> }]);
  render(<AuthContext.Provider value={user}><RouterProvider router={router} /></AuthContext.Provider>);
  return router;
}
async function fill() {
  fireEvent.change(await screen.findByLabelText('Назва англійською'), { target: { value: 'Texture' } });
  for (const [name, value] of [['Назва українською', 'Фактура'], ['Код атрибута', 'amber_texture'], ['Тип значення', 'select'],
    ['Значення для магазинів', 'global'], ['Обов’язкове заповнення', 'false'], ['Показувати на сторінці товару', 'true'],
    ['Використовувати в пошуку', 'true'], ['Фільтр у каталозі', 'true'], ['Фільтр у результатах пошуку', 'false']]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  }
}
it('requires explicit attribute profile, preserves typed settings across stages and guards navigation', async () => {
  shell({ initialAttributeCode: 'amber_texture' });
  expect(screen.getByLabelText('Код атрибута').value).toBe('amber_texture');
  expect(screen.getByLabelText('Обов’язкове заповнення').value).toBe('');
  expect(screen.getByRole('button', { name: 'Перевірити атрибут' }).disabled).toBe(true);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: '2. Підключення до набору' }));
  expect(screen.getByLabelText('Набір атрибутів').value).toBe('142');
  expect(screen.queryByRole('option', { name: /Ціна/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '1. Новий атрибут' }));
  expect(screen.getByLabelText('Назва українською').value).toBe('Фактура');
  expect(screen.getByLabelText('Фільтр у результатах пошуку').value).toBe('false');
  fireEvent.click(screen.getByRole('link', { name: 'Інша сторінка' }));
  await screen.findByRole('dialog', { name: 'Незбережені зміни' });
  fireEvent.click(screen.getByRole('button', { name: 'Залишитися' }));
  expect(screen.getByLabelText('Назва українською').value).toBe('Фактура');
  expect(api.post).not.toHaveBeenCalled();
});
it('preview never creates an attribute; explicit apply shows durable result and opens exact assignment', async () => {
  const changed = vi.fn(); shell({ onResourceChanged: changed }); await fill();
  api.post.mockResolvedValueOnce({ data: { label: 'Фактура', previewToken: 'reviewed', target: { attributeCode: 'amber_texture' } } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити атрибут' }));
  await screen.findByRole('button', { name: 'Створити атрибут у Magento' });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post.mock.calls[0][1]).toMatchObject({ attributeCode: 'amber_texture', required: false, visibleOnFront: true, filterableInSearch: false });
  api.post.mockResolvedValueOnce({ data: { id: 'created', kind: 'attribute', state: 'verified', label: 'Фактура', attributeCode: 'amber_texture', message: 'Атрибут створено та перевірено.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Створити атрибут у Magento' }));
  await screen.findByText('Атрибут створено та перевірено.');
  expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Підключити до набору' }));
  expect(screen.getByLabelText('Атрибут').value).toBe('amber_texture');
  expect(screen.getByLabelText('Набір атрибутів').value).toBe('142');
  expect(api.post).toHaveBeenCalledTimes(2);
});
it('existing member offers rules handoff without assignment POST, and delegated users cannot create', async () => {
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/actions') ? [] : { ...context, members: [{ id: 99, code: 'color' }] } }));
  const ready = vi.fn(); shell({ mode: 'assign', initialAttributeCode: 'color', onReady: ready });
  fireEvent.click(await screen.findByRole('button', { name: 'Налаштувати передачу характеристики' }));
  expect(ready).toHaveBeenCalledWith(expect.objectContaining({ attributeCode: 'color', attributeSet: { id: 142, name: 'Браслети' } }));
  expect(api.post).not.toHaveBeenCalled();
  cleanup(); vi.clearAllMocks(); shell({}, { ...auth, roles: [{ key: 'custom_publisher' }] });
  expect(screen.queryByRole('button', { name: 'Перевірити атрибут' })).toBeNull();
  expect(api.get).not.toHaveBeenCalled();
});
it('reload exposes exact returned action and reconciles without a second create or implicit assignment', async () => {
  const action = { id: 'original', kind: 'attribute', state: 'returned', attributeCode: 'amber_texture', label: 'Фактура', canReconcile: true, message: 'Перевірка не завершена.' };
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/actions') ? [action] : context }));
  shell(); fireEvent.click(await screen.findByText('Збережені дії з атрибутами'));
  expect(api.post).not.toHaveBeenCalled();
  api.post.mockResolvedValueOnce({ data: { ...action, state: 'verified', canReconcile: false, message: 'Створення перевірено.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити результат' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/magento-integration/attributes/reconcile', { actionId: 'original' }));
  await screen.findByText('Створення перевірено.');
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('changing the set hides old membership evidence until the exact new set has been read', async () => {
  let finish;
  api.get.mockImplementation((path, options) => {
    if (path.endsWith('/actions')) return Promise.resolve({ data: [] });
    if (options.params.attributeSetId === '152') return new Promise((resolve) => { finish = resolve; });
    return Promise.resolve({ data: { ...context, sets: [...context.sets, { id: 152, name: 'Інший набір' }], members: [{ id: 99, code: 'color' }] } });
  });
  shell({ mode: 'assign', initialAttributeCode: 'color', onReady: vi.fn() });
  await screen.findByRole('button', { name: 'Налаштувати передачу характеристики' });
  fireEvent.change(screen.getByLabelText('Набір атрибутів'), { target: { value: '152' } });
  expect(screen.queryByRole('button', { name: 'Налаштувати передачу характеристики' })).toBeNull();
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  finish({ data: { ...context, set: { id: 152, name: 'Інший набір' }, groups: [], members: [] } });
  await waitFor(() => expect(screen.queryByText('Перевіряємо структуру Magento…')).toBeNull());
  expect(screen.queryByRole('button', { name: 'Налаштувати передачу характеристики' })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

it('a recovered assignment puts the receipt first and collapses forms until explicitly reopened', async () => {
  const action = { id: 'membership', kind: 'attribute_assignment', state: 'dispatched', attributeCode: 'color', label: 'Колір', canReconcile: true, message: 'Результат очікує перевірки.' };
  api.get.mockImplementation((path) => Promise.resolve({ data: path.endsWith('/actions') ? [action] : context }));
  shell({ onReady: vi.fn() });
  fireEvent.click(await screen.findByText('Збережені дії з атрибутами'));
  api.post.mockResolvedValueOnce({ data: { ...action, state: 'verified', canReconcile: false, message: 'Підключення перевірено.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити результат' }));
  await screen.findByText('Підключення перевірено.');
  expect(screen.queryByRole('button', { name: 'Перевірити атрибут' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Налаштувати передачу характеристики' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Відкрити форми атрибутів' }));
  expect(screen.getByRole('button', { name: 'Перевірити атрибут' })).toBeTruthy();
  expect(api.post.mock.calls).toEqual([['/admin/magento-integration/attributes/reconcile', { actionId: 'membership' }]]);
});
