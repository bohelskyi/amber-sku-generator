import AdministrationPage from '../src/pages/AdministrationPage.jsx';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav.jsx';
import { api } from '../src/lib/api.js';
import {
  getPermissionDomain,
  getPermissionPresentation,
  groupPermissions,
} from '../src/lib/role-management.js';
import RolesPage from '../src/pages/RolesPage.jsx';

const permissions = [
  { key: 'products.view', description: 'View products', reserved: false },
  { key: 'corrections.view', description: 'View corrections', reserved: false },
  { key: 'users.manage', description: 'Manage users', reserved: true },
  { key: 'roles.manage', description: 'Manage roles', reserved: true },
  { key: 'audit.view', description: 'View audit', reserved: true },
];

const roles = [{
  id: 1,
  key: 'administrator',
  displayName: 'Administrator',
  description: 'Protected',
  isSystem: true,
  isProtected: true,
  status: 'active',
  version: 1,
  permissionKeys: permissions.map((permission) => permission.key),
  permissionCount: permissions.length,
  assignedUserCount: 1,
  activeAssignedUserCount: 1,
  disabledAssignedUserCount: 0,
}, {
  id: 2,
  key: 'manager',
  displayName: 'Manager',
  description: 'Editable system role',
  isSystem: true,
  isProtected: false,
  status: 'active',
  version: 4,
  permissionKeys: ['products.view'],
  permissionCount: 1,
  assignedUserCount: 1,
  activeAssignedUserCount: 1,
  disabledAssignedUserCount: 0,
}];

function response(data) {
  return { data, status: 200, headers: {}, config: {} };
}

function authValue(rolePermissions = ['roles.manage']) {
  return {
    applicationUser: { id: 42, status: 'active' },
    identity: { name: 'Admin' },
    roles: [{ id: 1, key: 'administrator', displayName: 'Administrator' }],
    permissions: rolePermissions,
    refresh: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn(),
  };
}

function renderPage(children, auth = authValue()) {
  const router = createMemoryRouter([{
    path: '*',
    element: <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>,
  }], { initialEntries: ['/admin/roles'] });
  return render(<RouterProvider router={router} />);
}

afterEach(() => cleanup());

describe('role-management UI', () => {
  it('groups the server permission catalog by stable capability domain', () => {
    expect(getPermissionDomain('sku_schemas.publish')).toBe('catalog');
    expect(groupPermissions(permissions).map((group) => group.key)).toEqual([
      'products', 'corrections', 'access',
    ]);
  });

  it('keeps stable permission keys while presenting Ukrainian names and descriptions', () => {
    expect(getPermissionPresentation({ key: 'products.view', description: 'View products' })).toEqual({
      label: 'Перегляд товарів',
      description: 'Перегляд списку та основних даних товарів.',
    });
    expect(getPermissionPresentation({ key: 'future.permission', description: 'Future permission' })).toEqual({
      label: 'future.permission',
      description: 'Future permission',
    });
  });

  it('shows navigation and loads roles only through roles.manage', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions }
    ));
    renderPage(<><WorkspaceNav /><AdministrationPage /><RolesPage /></>);
    expect(screen.getByRole('link', { name: 'Адміністрування' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Ролі/ })).toBeTruthy();
    expect(await screen.findByText('Захищена')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/admin/roles');

    cleanup();
    get.mockClear();
    renderPage(<><WorkspaceNav /><AdministrationPage /><RolesPage /></>, authValue(['products.view']));
    expect(screen.queryByRole('link', { name: /Ролі/ })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Недостатньо прав');
    expect(get.mock.calls.some(([url]) => url.startsWith('/admin/roles'))).toBe(false);
  });

  it('presents selectable roles as one list with status, protection, and counts', async () => {
    const listedRoles = [roles[0], { ...roles[1], status: 'inactive' }];
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles: listedRoles } : { permissions }
    ));
    renderPage(<RolesPage />);

    const list = await screen.findByRole('list', { name: 'Ролі' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('button', { name: /Administrator/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(rows[0]).getByLabelText('Захищена роль')).toBeTruthy();
    expect(within(rows[0]).getByText('5 дозволів · 1 користувачів')).toBeTruthy();
    expect(within(rows[1]).getByText('Деактивована')).toBeTruthy();

    const manager = within(rows[1]).getByRole('button', { name: /Manager/ });
    manager.focus();
    expect(document.activeElement).toBe(manager);
    fireEvent.click(manager);
    expect(manager.getAttribute('aria-pressed')).toBe('true');
    expect(within(rows[0]).getByRole('button', { name: /Administrator/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('edits Manager, locks reserved permissions, and confirms live permission removal', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions }
    ));
    const put = vi.spyOn(api, 'put').mockResolvedValue(response({
      role: { ...roles[1], version: 5, permissionKeys: [], permissionCount: 0 },
    }));
    const auth = authValue();
    renderPage(<RolesPage />, auth);

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    expect(screen.getByText('Перегляд товарів')).toBeTruthy();
    const reserved = screen.getByRole('checkbox', { name: /Керування користувачами/ });
    expect(reserved.disabled).toBe(true);
    const productsView = screen.getByRole('checkbox', { name: /Перегляд товарів/ });
    expect(productsView.disabled).toBe(false);
    fireEvent.click(productsView);
    expect(screen.getByText('Запропоновані зміни')).toBeTruthy();
    expect(screen.getByText(/Вилучаються: Перегляд товарів/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    expect(await screen.findByRole('dialog', { name: 'Змінити дозволи ролі «Manager»?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Змінити дозволи' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/roles/2/permissions', {
      permissionKeys: [],
      expectedVersion: 4,
      expectedActiveAssignedUserCount: 1,
    }));
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('preserves attempted edits and shows the newer server version after a conflict', async () => {
    let currentRoles = roles;
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles: currentRoles } : { permissions }
    ));
    vi.spyOn(api, 'patch').mockImplementation(async () => {
      currentRoles = [roles[0], { ...roles[1], displayName: 'Manager server', version: 5 }];
      throw { response: { status: 409, data: { code: 'ROLE_VERSION_CONFLICT' } } };
    });
    renderPage(<RolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    const name = screen.getByLabelText('Назва');
    fireEvent.change(name, { target: { value: 'Manager draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    expect(await screen.findByText('На сервері є новіша версія ролі')).toBeTruthy();
    expect(screen.getAllByText(/новіша версія ролі/)).toHaveLength(1);
    expect(name.value).toBe('Manager draft');
    expect(screen.getByText(/№5, «Manager server»/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Зберегти зміни' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Завантажити актуальну версію' }));
    expect(name.value).toBe('Manager server');
    fireEvent.change(name, { target: { value: 'Reviewed manager' } });
    expect(screen.getByRole('button', { name: 'Зберегти зміни' }).disabled).toBe(false);
  });

  it('keeps conflict reload failure details in the single conflict notice', async () => {
    let roleReads = 0;
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/admin/roles') {
        roleReads += 1;
        if (roleReads > 1) throw { response: { status: 503, data: { error: 'roles unavailable' } } };
        return response({ roles });
      }
      return response({ permissions });
    });
    vi.spyOn(api, 'patch').mockRejectedValue({ response: { status: 409, data: { code: 'ROLE_VERSION_CONFLICT' } } });
    renderPage(<RolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    const name = screen.getByLabelText('Назва');
    fireEvent.change(name, { target: { value: 'Manager draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    expect(await screen.findByText('На сервері є новіша версія ролі')).toBeTruthy();
    expect(screen.getByText(/Не вдалося завантажити актуальну версію/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Повторити завантаження' })).toBeTruthy();
    expect(name.value).toBe('Manager draft');
    expect(screen.getByRole('button', { name: 'Зберегти зміни' }).disabled).toBe(true);
  });

  it('reports metadata saved separately when the permission command fails', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions }
    ));
    vi.spyOn(api, 'patch').mockResolvedValue(response({ role: {
      ...roles[1], displayName: 'Updated manager', version: 5,
    } }));
    vi.spyOn(api, 'put').mockRejectedValue({ response: { status: 500, data: { error: 'permission failure' } } });
    renderPage(<RolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Updated manager' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Перегляд товарів/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Змінити дозволи' }));

    expect(await screen.findByText('Назву й опис збережено, дозволи не збережено.')).toBeTruthy();
    expect(screen.getByLabelText('Назва').value).toBe('Updated manager');
  });

  it('guards role changes until the operator explicitly discards an edited form', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions }
    ));
    renderPage(<RolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Unsaved manager' } });
    fireEvent.click(screen.getByRole('button', { name: /Administrator/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Незбережені зміни' });
    expect(screen.getByRole('button', { name: /Manager/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).queryByRole('button', { name: 'Зберегти й перейти' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Відкинути й перейти' }));
    expect(screen.getByRole('button', { name: /Administrator/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a successful role write distinct from a failed follow-up refresh', async () => {
    let roleReads = 0;
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/admin/roles') {
        roleReads += 1;
        if (roleReads > 1) throw { response: { status: 503, data: { error: 'refresh unavailable' } } };
        return response({ roles });
      }
      return response({ permissions });
    });
    vi.spyOn(api, 'patch').mockResolvedValue(response({ role: {
      ...roles[1], displayName: 'Saved manager', version: 5,
    } }));
    renderPage(<RolesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    fireEvent.change(screen.getByLabelText('Назва'), { target: { value: 'Saved manager' } });
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    expect(await screen.findByText('Роль оновлено, але дані на екрані не повністю оновлено.')).toBeTruthy();
    expect(screen.getByLabelText('Назва').value).toBe('Saved manager');
    expect(screen.queryByText('Не вдалося зберегти роль.')).toBeNull();
  });

  it('filters permissions by operator language while keeping technical keys on demand', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions: [...permissions, { key: 'sku_schemas.publish', description: 'Publish schemas', reserved: false }] }
    ));
    renderPage(<RolesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));

    expect(screen.queryByText('sku_schemas.publish')).toBeNull();
    fireEvent.change(screen.getByLabelText('Пошук дозволу'), { target: { value: 'sku_schemas.publish' } });
    expect(screen.getByText('Публікація схеми SKU')).toBeTruthy();
    expect(screen.queryByText('Перегляд товарів')).toBeNull();
    fireEvent.click(screen.getByText('Технічні ключі дозволів'));
    expect(screen.getByText('sku_schemas.publish')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Група дозволів'), { target: { value: 'products' } });
    expect(screen.getByText('Дозволів за цими умовами не знайдено.')).toBeTruthy();
  });
});
