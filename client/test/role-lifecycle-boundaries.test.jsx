import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthContext } from '../src/auth/auth-context.js';
import RolesPage from '../src/pages/RolesPage.jsx';
import { api } from '../src/lib/api.js';

const permissions = [{ key: 'products.view', description: 'View products', reserved: false },
  { key: 'roles.manage', description: 'Manage roles', reserved: true }];
const role = (extra = {}) => ({ id: 12, key: 'reviewers', displayName: 'Перевіряльники',
  description: 'Перевірка товарів', isSystem: false, isProtected: false, status: 'active',
  version: 7, permissionKeys: ['products.view'], permissionCount: 1,
  assignedUserCount: 0, activeAssignedUserCount: 0, disabledAssignedUserCount: 0, ...extra });
const response = data => ({ data });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let listedRoles, get, post, patch, put;

beforeEach(() => {
  listedRoles = [role()];
  get = vi.spyOn(api, 'get').mockImplementation(async url => {
    if (url === '/admin/roles') return response({ roles: listedRoles });
    if (url === '/admin/roles/permissions') return response({ permissions });
    throw new Error(`Unexpected read: ${url}`);
  });
  post = vi.spyOn(api, 'post').mockImplementation(async url => { throw new Error(`Unexpected write: ${url}`); });
  patch = vi.spyOn(api, 'patch').mockImplementation(async url => { throw new Error(`Unexpected patch: ${url}`); });
  put = vi.spyOn(api, 'put').mockImplementation(async url => { throw new Error(`Unexpected replacement: ${url}`); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount() {
  const auth = { permissions: ['roles.manage'], roles: [{ id: 1 }],
    applicationUser: { id: 42, status: 'active' }, refresh: vi.fn().mockResolvedValue(undefined) };
  const router = createMemoryRouter([{ path: '*', element: <AuthContext.Provider value={auth}><RolesPage /></AuthContext.Provider> }],
    { initialEntries: ['/admin/roles'] });
  const view = render(<RouterProvider router={router} />);
  await screen.findByRole('list', { name: 'Ролі' });
  return { ...view, auth };
}
async function createForm() {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Створити роль' }));
  expect(screen.getByRole('heading', { name: 'Нова роль' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Оператори звітів' } });
  fireEvent.change(screen.getByLabelText('Опис'), { target: { value: 'Лише перегляд товарів' } });
  fireEvent.change(screen.getByRole('searchbox', { name: 'Пошук дозволу' }), { target: { value: 'products.view' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Перегляд товарів/ }));
  return screen.getAllByRole('button', { name: 'Створити роль' }).at(-1);
}
const createdRole = () => role({ id: 25, key: 'report_operators', displayName: 'Оператори звітів',
  description: 'Лише перегляд товарів', version: 1 });
const createPayload = { displayName: 'Оператори звітів', description: 'Лише перегляд товарів', permissionKeys: ['products.view'] };

it('creates exactly the reviewed new role and prevents a second pending submit', async () => {
  const pending = deferred();
  post.mockImplementation(async (url, input) => {
    expect(url).toBe('/admin/roles'); expect(input).toEqual(createPayload);
    await pending.promise;
    listedRoles = [...listedRoles, createdRole()];
    return response({ role: createdRole() });
  });
  const create = await createForm();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(create);
  expect(create.disabled).toBe(true);
  expect(screen.getByLabelText('Назва').disabled).toBe(true);
  fireEvent.click(create);
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve());
  await screen.findByText('Роль створено.');
  expect(screen.getByRole('heading', { name: 'Оператори звітів' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Зберегти зміни' }).disabled).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
  expect(patch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
});

it('preserves new-role input after a server refusal without claiming creation or retrying', async () => {
  post.mockRejectedValue({ response: { status: 409, data: { code: 'ROLE_DISPLAY_NAME_CONFLICT' } } });
  const create = await createForm();
  fireEvent.click(create);
  await screen.findByText('Роль з такою назвою вже існує.');
  await waitFor(() => expect(create.disabled).toBe(false));
  expect(screen.getByRole('heading', { name: 'Нова роль' })).toBeTruthy();
  expect(screen.getByLabelText('Назва').value).toBe(createPayload.displayName);
  expect(screen.getByLabelText('Опис').value).toBe(createPayload.description);
  expect(screen.getByRole('checkbox', { name: /Перегляд товарів/ }).checked).toBe(true);
  expect(screen.queryByText('Роль створено.')).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/admin/roles', createPayload);
});

it('retains a successfully created role if list refresh fails and does not create it again', async () => {
  post.mockImplementation(async () => {
    get.mockRejectedValue(new Error('refresh offline'));
    return response({ role: createdRole() });
  });
  const create = await createForm(); fireEvent.click(create);
  await screen.findByText('Роль створено, але список не оновлено.');
  expect(screen.getByRole('heading', { name: 'Оператори звітів' })).toBeTruthy();
  const save = screen.getByRole('button', { name: 'Зберегти зміни' });
  await waitFor(() => expect(screen.getByLabelText('Назва').disabled).toBe(false));
  expect(save.disabled).toBe(true);
  fireEvent.click(save);
  expect(post).toHaveBeenCalledTimes(1);
  expect(patch).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
});

it('cancels deactivation without a write, then submits the exact reviewed role version once', async () => {
  const pending = deferred();
  post.mockImplementation(async () => {
    await pending.promise;
    listedRoles = [role({ status: 'inactive', version: 8 })];
    return response({ role: listedRoles[0] });
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Деактивувати' }));
  let dialog = await screen.findByRole('dialog', { name: 'Деактивувати роль «Перевіряльники»?' });
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Деактивувати' }));
  dialog = await screen.findByRole('dialog', { name: 'Деактивувати роль «Перевіряльники»?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Деактивувати роль' }));
  expect(screen.getByRole('button', { name: 'Деактивувати' }).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Деактивувати' }));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/admin/roles/12/deactivate', { expectedVersion: 7 });
  await act(async () => pending.resolve());
  await screen.findByText('Роль деактивовано.');
  expect(screen.getByRole('button', { name: 'Активувати' }).disabled).toBe(false);
  expect(screen.queryByRole('button', { name: 'Деактивувати' })).toBeNull();
});

it('reactivates using the current version and keeps write success distinct from a failed refresh', async () => {
  listedRoles = [role({ status: 'inactive', version: 9 })];
  post.mockImplementation(async () => {
    get.mockRejectedValue(new Error('refresh offline'));
    return response({ role: role({ status: 'active', version: 10 }) });
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Активувати' }));
  await screen.findByText('Роль активовано. Список не оновлено.');
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/admin/roles/12/reactivate', { expectedVersion: 9 });
  expect(screen.queryByRole('button', { name: 'Активувати' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Деактивувати' }).disabled).toBe(false);
});

it.each([
  ['active', { assignedUserCount: 1, activeAssignedUserCount: 1, disabledAssignedUserCount: 0 }],
  ['disabled', { assignedUserCount: 1, activeAssignedUserCount: 0, disabledAssignedUserCount: 1 }],
])('refuses deactivation while a %s user still holds the role', async (_state, counts) => {
  listedRoles = [role(counts)];
  await mount();
  const deactivate = screen.getByRole('button', { name: 'Деактивувати' });
  expect(deactivate.disabled).toBe(true);
  expect(deactivate.title).toBe('Спочатку призначте користувачам інші ролі');
  fireEvent.click(deactivate);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('offers no lifecycle mutation for the protected Administrator role', async () => {
  listedRoles = [role({ id: 1, key: 'administrator', displayName: 'Administrator', isSystem: true, isProtected: true })];
  await mount();
  expect(screen.getByRole('heading', { name: 'Administrator' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Деактивувати' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Активувати' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Зберегти зміни' })).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

it('retains a status conflict after refreshing current state and never retries the mutation automatically', async () => {
  post.mockImplementation(async () => {
    listedRoles = [role({ version: 8 })];
    throw { response: { status: 409, data: { code: 'ROLE_VERSION_CONFLICT' } } };
  });
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Деактивувати' }));
  const dialog = await screen.findByRole('dialog', { name: 'Деактивувати роль «Перевіряльники»?' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Деактивувати роль' }));
  await screen.findByText('Роль вже змінилася. Оновіть дані та спробуйте ще раз.');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Деактивувати' }).disabled).toBe(false));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/admin/roles/12/deactivate', { expectedVersion: 7 });
  expect(screen.queryByText('Роль деактивовано.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Активувати' })).toBeNull();
  expect(get.mock.calls.filter(([url]) => url === '/admin/roles')).toHaveLength(2);
});
