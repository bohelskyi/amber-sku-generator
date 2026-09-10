import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../src/auth/auth-context.js';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav.jsx';
import { api } from '../src/lib/api.js';
import { getPermissionDomain, groupPermissions } from '../src/lib/role-management.js';
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

afterEach(() => cleanup());

describe('role-management UI', () => {
  it('groups the server permission catalog by stable capability domain', () => {
    expect(getPermissionDomain('sku_schemas.publish')).toBe('catalog');
    expect(groupPermissions(permissions).map((group) => group.key)).toEqual([
      'products', 'corrections', 'access',
    ]);
  });

  it('shows navigation and loads roles only through roles.manage', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions }
    ));
    render(
      <AuthContext.Provider value={authValue()}>
        <MemoryRouter><WorkspaceNav /><RolesPage /></MemoryRouter>
      </AuthContext.Provider>
    );
    expect(await screen.findByRole('link', { name: /Ролі/ })).toBeTruthy();
    expect(await screen.findByText('Захищена')).toBeTruthy();
    expect(get).toHaveBeenCalledWith('/admin/roles');

    cleanup();
    get.mockClear();
    render(
      <AuthContext.Provider value={authValue(['products.view'])}>
        <MemoryRouter><WorkspaceNav /><RolesPage /></MemoryRouter>
      </AuthContext.Provider>
    );
    expect(screen.queryByRole('link', { name: /Ролі/ })).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Недостатньо прав');
    expect(get).not.toHaveBeenCalled();
  });

  it('edits Manager, locks reserved permissions, and confirms live permission removal', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/roles' ? { roles } : { permissions }
    ));
    const put = vi.spyOn(api, 'put').mockResolvedValue(response({
      role: { ...roles[1], version: 5, permissionKeys: [], permissionCount: 0 },
    }));
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const auth = authValue();
    render(
      <AuthContext.Provider value={auth}>
        <RolesPage />
      </AuthContext.Provider>
    );

    fireEvent.click(await screen.findByRole('button', { name: /Manager/ }));
    const reserved = screen.getByRole('checkbox', { name: /users\.manage/ });
    expect(reserved.disabled).toBe(true);
    const productsView = screen.getByRole('checkbox', { name: /products\.view/ });
    expect(productsView.disabled).toBe(false);
    fireEvent.click(productsView);
    fireEvent.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(put).toHaveBeenCalledWith('/admin/roles/2/permissions', {
      permissionKeys: [],
      expectedVersion: 4,
      expectedActiveAssignedUserCount: 1,
    }));
    expect(auth.refresh).not.toHaveBeenCalled();
  });
});
