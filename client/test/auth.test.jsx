import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../src/auth/AuthGate.jsx';
import { AuthProvider } from '../src/auth/AuthProvider.jsx';
import { AuthContext } from '../src/auth/auth-context.js';
import {
  getCurrentReturnTo,
  getIdentityDisplayName,
  normalizeCurrentSession,
} from '../src/auth/auth-model.js';
import { WorkspaceNav } from '../src/components/app/WorkspaceNav.jsx';
import { ExportTools } from '../src/components/app/ExportTools.jsx';
import { HistoryTable } from '../src/components/app/HistoryTable.jsx';
import { HomeDashboard } from '../src/components/app/HomeDashboard.jsx';
import { RecountConfirmDialog } from '../src/components/app/RecountConfirmDialog.jsx';
import { getPermissionUiState, getRecountUiMode } from '../src/lib/permission-ui.js';
import AdminPage from '../src/pages/AdminPage.jsx';
import CorrectionRequestsPage from '../src/pages/CorrectionRequestsPage.jsx';
import { api, createApiClient } from '../src/lib/api.js';
import {
  APPLICATION_USER_STATUS_LABELS,
} from '../src/lib/user-management.js';
import UsersPage from '../src/pages/UsersPage.jsx';

const identity = {
  issuer: 'https://auth.example/realms/amber',
  sub: 'immutable-subject',
  preferred_username: 'amber.user',
  name: 'Amber User',
  given_name: 'Amber',
  family_name: 'User',
  email: 'amber.user@example.test',
  authenticatedAt: '2026-09-09T10:00:00.000Z',
};

const currentSession = {
  identity,
  applicationUser: {
    id: 42,
    status: 'active',
    preferredUsername: 'amber.user',
    displayName: 'Amber User',
    givenName: 'Amber',
    familyName: 'User',
    email: 'amber.user@example.test',
  },
  roles: [{ id: 1, key: 'administrator', displayName: 'Administrator' }],
  permissions: ['products.view', 'users.manage'],
  csrfToken: 'in-memory-csrf-token',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(data, config = {}) {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  };
}

function locationStub(overrides = {}) {
  return {
    pathname: '/',
    search: '',
    hash: '',
    assign: vi.fn(),
    ...overrides,
  };
}

function noOpBinding() {
  return () => {};
}

function renderAuth({ apiClient, children, bindApiAuth = noOpBinding, locationObject }) {
  return render(
    <AuthProvider
      apiClient={apiClient}
      bindApiAuth={bindApiAuth}
      locationObject={locationObject || locationStub()}
    >
      <AuthGate>{children || <div>Business application</div>}</AuthGate>
    </AuthProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe('authentication bootstrap and gate', () => {
  it('shows a neutral loading state and does not mount business content before /me resolves', async () => {
    const pending = deferred();
    const apiClient = { get: vi.fn(() => pending.promise), post: vi.fn() };
    let businessMounts = 0;
    function BusinessApp() {
      useEffect(() => { businessMounts += 1; }, []);
      return <div>Protected business app</div>;
    }

    renderAuth({ apiClient, children: <BusinessApp /> });

    expect(screen.getByText('Перевіряємо сеанс…')).toBeTruthy();
    expect(screen.queryByText('Protected business app')).toBeNull();
    expect(businessMounts).toBe(0);

    pending.resolve(response(currentSession));
    await screen.findByText('Protected business app');
    expect(businessMounts).toBe(1);
  });

  it('bootstraps an authenticated session and retains only normalized identity fields', async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue(response({
        ...currentSession,
        identity: {
          ...identity,
          access_token: 'must-not-survive',
          refresh_token: 'must-not-survive',
          id_token: 'must-not-survive',
          arbitrary_claim: 'must-not-survive',
        },
      })),
      post: vi.fn(),
    };

    renderAuth({ apiClient });

    await screen.findByText('Business application');
    expect(apiClient.get).toHaveBeenCalledWith('/auth/me', { skipAuthHandling: true });
    expect(normalizeCurrentSession((await apiClient.get.mock.results[0].value).data)).toEqual(currentSession);
  });

  it('treats the initial /me 401 as unauthenticated without retry or error loops', async () => {
    const apiClient = {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
      post: vi.fn(),
    };

    renderAuth({ apiClient });

    await screen.findByRole('button', { name: 'Увійти' });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows pending approval without mounting business content and allows logout', async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue(response({
        ...currentSession,
        applicationUser: { ...currentSession.applicationUser, status: 'pending' },
        roles: [],
        permissions: [],
      })),
      post: vi.fn().mockResolvedValue(response({ logoutUrl: null })),
    };
    const locationObject = locationStub();

    renderAuth({ apiClient, locationObject });

    await screen.findByText('Доступ очікує підтвердження');
    expect(screen.queryByText('Business application')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Вийти' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/auth/logout'));
    expect(locationObject.assign).toHaveBeenCalledWith('/');
  });

  it('shows disabled access without treating the session as unauthenticated', async () => {
    const apiClient = {
      get: vi.fn().mockResolvedValue(response({
        ...currentSession,
        applicationUser: { ...currentSession.applicationUser, status: 'disabled' },
      })),
      post: vi.fn().mockResolvedValue(response({ logoutUrl: null })),
    };
    const locationObject = locationStub();

    renderAuth({ apiClient, locationObject });

    await screen.findByText('Доступ вимкнено');
    expect(screen.queryByRole('button', { name: 'Увійти' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Вийти' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/auth/logout'));
    expect(locationObject.assign).toHaveBeenCalledWith('/');
  });

  it('shows a non-sensitive provider error and retries /me on demand', async () => {
    const apiClient = {
      get: vi.fn()
        .mockRejectedValueOnce(new Error('internal upstream detail'))
        .mockResolvedValueOnce(response(currentSession)),
      post: vi.fn(),
    };

    renderAuth({ apiClient });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Не вдалося перевірити сеанс');
    expect(alert.textContent).not.toContain('internal upstream detail');
    fireEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
    await screen.findByText('Business application');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });
});

describe('login, identity, and logout UI', () => {
  it('starts login through same-origin top-level navigation with the current SPA return path', async () => {
    const apiClient = {
      get: vi.fn().mockRejectedValue({ response: { status: 401 } }),
      post: vi.fn(),
    };
    const locationObject = locationStub({
      pathname: '/admin/repricing',
      search: '?draft=12',
      hash: '#items',
    });

    renderAuth({ apiClient, locationObject });
    fireEvent.click(await screen.findByRole('button', { name: 'Увійти' }));

    expect(locationObject.assign).toHaveBeenCalledWith(
      '/api/auth/login?returnTo=%2Fadmin%2Frepricing%3Fdraft%3D12%23items'
    );
    expect(getCurrentReturnTo({ pathname: '//evil.test', search: '', hash: '' })).toBe('/');
  });

  it('displays name before username and logs out with in-memory CSRF before top-level navigation', async () => {
    const requests = [];
    const logoutUrl = 'https://auth.example/realms/amber/protocol/openid-connect/logout?client_id=amber-sku-manager';
    const isolated = createApiClient();
    isolated.client.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url === '/auth/me') return response(currentSession, config);
      return response({ logoutUrl }, config);
    };
    const locationObject = locationStub();

    renderAuth({
      apiClient: isolated.client,
      bindApiAuth: isolated.configureAuth,
      locationObject,
      children: (
        <MemoryRouter>
          <WorkspaceNav />
        </MemoryRouter>
      ),
    });

    await screen.findByText('Amber User');
    expect(getIdentityDisplayName({ preferred_username: 'fallback.user' })).toBe('fallback.user');
    fireEvent.click(screen.getByRole('button', { name: 'Вийти' }));
    await waitFor(() => expect(locationObject.assign).toHaveBeenCalledWith(logoutUrl));

    const logoutRequest = requests.find((request) => request.url === '/auth/logout');
    expect(logoutRequest.method).toBe('post');
    expect(logoutRequest.headers.get('X-CSRF-Token')).toBe(currentSession.csrfToken);
    expect(logoutRequest.withCredentials).toBe(true);
  });

  it('falls back to the application root when logoutUrl is null', async () => {
    const isolated = createApiClient();
    isolated.client.defaults.adapter = async (config) => (
      config.url === '/auth/me'
        ? response(currentSession, config)
        : response({ logoutUrl: null }, config)
    );
    const locationObject = locationStub();

    renderAuth({
      apiClient: isolated.client,
      bindApiAuth: isolated.configureAuth,
      locationObject,
      children: (
        <MemoryRouter>
          <WorkspaceNav />
        </MemoryRouter>
      ),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Вийти' }));
    await waitFor(() => expect(locationObject.assign).toHaveBeenCalledWith('/'));
  });
});

describe('Axios authentication integration', () => {
  it('leaves requests usable before provider initialization and suppresses bootstrap 401 notifications', async () => {
    const isolated = createApiClient();
    const onUnauthorized = vi.fn();
    const requests = [];
    isolated.client.defaults.adapter = async (config) => {
      requests.push(config);
      if (config.url === '/auth/me') {
        const error = new Error('Unauthorized');
        error.config = config;
        error.response = { status: 401 };
        throw error;
      }
      return response({}, config);
    };

    await isolated.client.post('/before-provider');
    expect(requests[0].headers.has('X-CSRF-Token')).toBe(false);

    const removeAuth = isolated.configureAuth({
      getCsrfToken: () => currentSession.csrfToken,
      onUnauthorized,
    });
    await isolated.client.get('/auth/me', { skipAuthHandling: true }).catch(() => {});
    expect(onUnauthorized).not.toHaveBeenCalled();
    removeAuth();
  });

  it('attaches CSRF only to unsafe methods while preserving same-origin credentials', async () => {
    const requests = [];
    const isolated = createApiClient();
    const removeAuth = isolated.configureAuth({
      getCsrfToken: () => currentSession.csrfToken,
    });
    isolated.client.defaults.adapter = async (config) => {
      requests.push(config);
      return response({}, config);
    };

    await isolated.client.get('/read');
    await isolated.client.head('/head');
    await isolated.client.post('/post');
    await isolated.client.put('/put');
    await isolated.client.patch('/patch');
    await isolated.client.delete('/delete');
    removeAuth();

    for (const request of requests.filter(({ method }) => ['get', 'head'].includes(method))) {
      expect(request.headers.has('X-CSRF-Token')).toBe(false);
    }
    for (const request of requests.filter(({ method }) => ['post', 'put', 'patch', 'delete'].includes(method))) {
      expect(request.headers.get('X-CSRF-Token')).toBe(currentSession.csrfToken);
      expect(request.withCredentials).toBe(true);
    }
  });

  it('moves an authenticated provider to unauthenticated after a later centralized 401', async () => {
    const isolated = createApiClient();
    isolated.client.defaults.adapter = async (config) => {
      if (config.url === '/auth/me') return response(currentSession, config);
      const error = new Error('Unauthorized');
      error.config = config;
      error.response = { status: 401 };
      throw error;
    };

    function ExpiredRequest() {
      return (
        <button type="button" onClick={() => { void isolated.client.get('/expired').catch(() => {}); }}>
          Make expired request
        </button>
      );
    }

    renderAuth({
      apiClient: isolated.client,
      bindApiAuth: isolated.configureAuth,
      children: <ExpiredRequest />,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Make expired request' }));
    await screen.findByRole('button', { name: 'Увійти' });
  });

  it.each([
    ['APP_ACCESS_DISABLED', 'disabled', 'Доступ вимкнено'],
    ['APP_ACCESS_PENDING', 'pending', 'Доступ очікує підтвердження'],
  ])('moves an active session to the AuthGate for %s without a refresh', async (
    errorCode,
    _accessStatus,
    expectedHeading
  ) => {
    const isolated = createApiClient();
    isolated.client.defaults.adapter = async (config) => {
      if (config.url === '/auth/me') return response(currentSession, config);
      const error = new Error('Forbidden');
      error.config = config;
      error.response = { status: 403, data: { code: errorCode } };
      throw error;
    };

    function AccessChangedRequest() {
      return (
        <button type="button" onClick={() => { void isolated.client.get('/business').catch(() => {}); }}>
          Check changed access
        </button>
      );
    }

    renderAuth({
      apiClient: isolated.client,
      bindApiAuth: isolated.configureAuth,
      children: <AccessChangedRequest />,
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Check changed access' }));
    await screen.findByText(expectedHeading);
    expect(screen.queryByRole('button', { name: 'Check changed access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Увійти' })).toBeNull();
  });

  it('keeps the active AuthGate session after INSUFFICIENT_PERMISSION', async () => {
    const isolated = createApiClient();
    isolated.client.defaults.adapter = async (config) => {
      if (config.url === '/auth/me') return response(currentSession, config);
      const error = new Error('Forbidden');
      error.config = config;
      error.response = { status: 403, data: { code: 'INSUFFICIENT_PERMISSION' } };
      throw error;
    };

    function PermissionDeniedRequest() {
      return (
        <button type="button" onClick={() => { void isolated.client.post('/forbidden').catch(() => {}); }}>
          Make forbidden request
        </button>
      );
    }

    renderAuth({
      apiClient: isolated.client,
      bindApiAuth: isolated.configureAuth,
      children: <PermissionDeniedRequest />,
    });

    const button = await screen.findByRole('button', { name: 'Make forbidden request' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make forbidden request' })).toBeTruthy());
    expect(screen.queryByText('Доступ вимкнено')).toBeNull();
    expect(screen.queryByText('Доступ очікує підтвердження')).toBeNull();
  });

  it('does not clear authentication after a centralized 403 response', async () => {
    const isolated = createApiClient();
    const onUnauthorized = vi.fn();
    const onAccessStatusChange = vi.fn();
    isolated.configureAuth({ onAccessStatusChange, onUnauthorized });
    isolated.client.defaults.adapter = async (config) => {
      const error = new Error('Forbidden');
      error.config = config;
      error.response = { status: 403 };
      throw error;
    };

    await isolated.client.post('/forbidden').catch(() => {});
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(onAccessStatusChange).not.toHaveBeenCalled();
  });

  it('does not persist authentication identity or CSRF data in browser storage', async () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const sessionSet = vi.spyOn(window.sessionStorage, 'setItem');
    const apiClient = {
      get: vi.fn().mockResolvedValue(response(currentSession)),
      post: vi.fn(),
    };

    renderAuth({ apiClient });
    await screen.findByText('Business application');

    expect(localSet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
  });
});

describe('application-user administration UI', () => {
  const managedUsers = [
    {
      id: 101,
      status: 'pending',
      displayName: 'Pending User',
      preferredUsername: 'pending.user',
      lastAuthenticatedAt: null,
      currentAssignmentId: null,
      role: null,
    },
    {
      id: 102,
      status: 'active',
      displayName: 'Active User',
      preferredUsername: 'active.user',
      lastAuthenticatedAt: '2026-09-09T10:00:00.000Z',
      currentAssignmentId: 202,
      role: { id: 3, key: 'storekeeper', displayName: 'Комірниця', isSystem: true, status: 'active' },
    },
    {
      id: 103,
      status: 'disabled',
      displayName: 'Disabled User',
      preferredUsername: 'disabled.user',
      lastAuthenticatedAt: '2026-09-08T10:00:00.000Z',
      currentAssignmentId: 203,
      role: { id: 2, key: 'manager', displayName: 'Керівник', isSystem: true, status: 'active' },
    },
  ];
  const roles = [
    { id: 1, key: 'administrator', displayName: 'Адміністратор', isSystem: true, status: 'active' },
    { id: 2, key: 'manager', displayName: 'Керівник', isSystem: true, status: 'active' },
    { id: 3, key: 'storekeeper', displayName: 'Комірниця', isSystem: true, status: 'active' },
    { id: 4, key: 'custom_sales', displayName: 'Продажі', isSystem: false, status: 'active' },
  ];

  function authValue(permissions = ['users.manage']) {
    return {
      identity,
      applicationUser: { id: 42, status: 'active' },
      permissions,
      logout: vi.fn(),
      refresh: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('shows the navigation entry only when users.manage is effective', () => {
    const { rerender } = render(
      <AuthContext.Provider value={authValue()}>
        <MemoryRouter><WorkspaceNav /></MemoryRouter>
      </AuthContext.Provider>
    );
    expect(screen.getByRole('link', { name: /Користувачі/ })).toBeTruthy();

    rerender(
      <AuthContext.Provider value={authValue(['products.view'])}>
        <MemoryRouter><WorkspaceNav /></MemoryRouter>
      </AuthContext.Provider>
    );
    expect(screen.queryByRole('link', { name: /Користувачі/ })).toBeNull();
  });

  it('does not load the user-management page without users.manage', () => {
    const get = vi.spyOn(api, 'get');
    render(
      <AuthContext.Provider value={authValue(['products.view'])}>
        <UsersPage />
      </AuthContext.Provider>
    );

    expect(screen.getByRole('alert').textContent).toContain('Недостатньо прав');
    expect(get).not.toHaveBeenCalled();
  });

  it('renders lifecycle states and performs approval, role, disable, and enable requests', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/users' ? { users: managedUsers } : { roles }
    ));
    const post = vi.spyOn(api, 'post').mockResolvedValue(response({}));
    const put = vi.spyOn(api, 'put').mockResolvedValue(response({}));

    render(
      <AuthContext.Provider value={authValue()}>
        <UsersPage />
      </AuthContext.Provider>
    );

    await screen.findByText('Pending User');
    for (const label of Object.values(APPLICATION_USER_STATUS_LABELS)) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const label of roles.map((role) => role.displayName)) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    fireEvent.change(screen.getByRole('combobox', { name: 'Роль для Pending User' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Підтвердити Pending User' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/admin/users/101/approve',
      { roleId: 2 }
    ));

    fireEvent.change(screen.getByRole('combobox', { name: 'Роль для Active User' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Змінити роль для Active User' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/admin/users/102/role',
      { roleId: 2, expectedAssignmentId: 202 }
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Вимкнути доступ для Active User' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/users/102/disable', {}));

    fireEvent.change(screen.getByRole('combobox', { name: 'Роль для Disabled User' }), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Увімкнути доступ для Disabled User' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/admin/users/103/enable',
      { roleId: 3, expectedAssignmentId: 203 }
    ));
  });

  it('refreshes auth immediately after a self-role change without requiring another admin request', async () => {
    const selfUser = {
      ...managedUsers[1],
      id: 42,
      displayName: 'Current Administrator',
      preferredUsername: 'current.admin',
      currentAssignmentId: 242,
      role: { id: 1, key: 'administrator', displayName: 'Адміністратор', isSystem: true, status: 'active' },
    };
    vi.spyOn(api, 'get').mockImplementation(async (url) => response(
      url === '/admin/users' ? { users: [selfUser] } : { roles }
    ));
    const put = vi.spyOn(api, 'put').mockResolvedValue(response({}));
    const auth = authValue();

    render(
      <AuthContext.Provider value={auth}>
        <UsersPage />
      </AuthContext.Provider>
    );

    await screen.findByText('Current Administrator');
    fireEvent.change(screen.getByRole('combobox', { name: 'Роль для Current Administrator' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', {
      name: 'Змінити роль для Current Administrator',
    }));

    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/admin/users/42/role',
      { roleId: 2, expectedAssignmentId: 242 }
    ));
    await waitFor(() => expect(auth.refresh).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

describe('permission-aware business UI', () => {
  const config = {
    categories: {
      BR: { code: 'BR', name: 'Браслети', requires_weight: 1 },
    },
    questions: {
      BR: [{
        q_db_id: 10,
        id: 'kind',
        label: 'Тип',
        display_order: 1,
        sku_index: 1,
        include_in_sku: 1,
        input_type: 'options',
        options: [{ db_id: 11, id: 1, sku_code: '1', label: 'Круглий', archived: 0 }],
      }],
    },
    extraConfig: {},
  };
  const pricing = {
    scenarios: [{
      id: 21,
      name: 'Базова матриця',
      group_name: 'Базова',
      match_json: {},
      axis_x_key: 'kind',
      axis_y_key: null,
      priority: 1,
      status: 'active',
      price_mode: 'fixed_uah',
      weight_bands: [],
      matrix: [{ x_val: 1, y_val: 0, price: '1250.0000' }],
    }],
    modifiers: [{ id: 31, match_json: { kind: 1 }, factor: '1.200000' }],
  };
  const authValue = (permissions) => ({
    identity,
    applicationUser: { id: 42, status: 'active' },
    permissions,
    roles: [],
    logout: vi.fn(),
  });

  const operationalProps = {
    config,
    exportStatus: null,
    skuToDecode: '',
    decodeData: null,
    decodeError: '',
    decodeErrorDetails: null,
    onStart: vi.fn(),
    onDecode: vi.fn(),
    onDecodeInputChange: vi.fn(),
  };

  it('hides Manager product/archive/export/direct-apply controls and keeps Storekeeper product workflows', () => {
    const managerUi = getPermissionUiState([
      'products.view',
      'products.decode',
      'corrections.create',
      'exports.view',
    ]);
    const storekeeperUi = getPermissionUiState([
      'products.view',
      'products.decode',
      'products.create',
      'products.archive',
      'products.recount',
      'corrections.create',
      'exports.view',
    ]);
    const history = [{
      id: 1,
      full_sku: 'BR1001',
      category: 'BR',
      weight: 10,
      total_price_uah: 1250,
    }];
    const commonActions = {
      exportFromSku: '',
      setExportFromSku: vi.fn(),
      exportToSku: '',
      setExportToSku: vi.fn(),
      exportError: '',
      setExportError: vi.fn(),
      isExportLoading: false,
      skuToDelete: '',
      setSkuToDelete: vi.fn(),
      onExportCsv: vi.fn(),
      onDelete: vi.fn(),
    };

    const { rerender } = render(
      <MemoryRouter>
      <>
        <HomeDashboard {...operationalProps} canCreateProducts={managerUi.canCreateProducts} />
        <HistoryTable history={history} config={config} selectedCat={null} canArchive={managerUi.canArchiveProducts} onCopyText={vi.fn()} onDecode={vi.fn()} onDelete={vi.fn()} />
        <ExportTools {...commonActions} canArchive={managerUi.canArchiveProducts} canCreateExport={managerUi.canCreateExports} />
      </>
      </MemoryRouter>
    );
    expect(screen.queryByText('Оберіть категорію')).toBeNull();
    expect(screen.getByText('Знайти та перевірити товар').closest('.home-top-workspace')?.classList.contains('is-decoder-only')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Архівувати' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Експорт CSV' })).toBeNull();

    rerender(
      <MemoryRouter>
      <>
        <HomeDashboard {...operationalProps} canCreateProducts={storekeeperUi.canCreateProducts} />
        <HistoryTable history={history} config={config} selectedCat={null} canArchive={storekeeperUi.canArchiveProducts} onCopyText={vi.fn()} onDecode={vi.fn()} onDelete={vi.fn()} />
        <ExportTools {...commonActions} canArchive={storekeeperUi.canArchiveProducts} canCreateExport={storekeeperUi.canCreateExports} />
      </>
      </MemoryRouter>
    );
    expect(screen.getByText('Оберіть категорію')).toBeTruthy();
    expect(screen.getByText('Знайти та перевірити товар').closest('.home-top-workspace')?.classList.contains('is-decoder-only')).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Архівувати' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Експорт CSV' })).toBeNull();

    expect(getRecountUiMode(managerUi)).toBe('request');
    expect(getRecountUiMode(storekeeperUi)).toBe('choice');
  });

  it('renders only the correction-request confirmation for Manager recounts', () => {
    const preview = {
      source: { sku: 'BR1001', totalPriceUah: 1000 },
      corrected: { fullSku: 'BR1002', totalPriceUah: 1250 },
      priceDeltaUah: 250,
    };
    render(
      <RecountConfirmDialog
        isOpen
        isApplying={false}
        preview={preview}
        reason=""
        manualPriceUah=""
        onManualPriceChange={vi.fn()}
        mode="request"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Створити запит' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Створити коригувальний артикул' })).toBeNull();
  });

  it('renders Manager price matrices and modifiers read-only without catalog.view', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/config') return response(config);
      if (url === '/admin/prices/BR') return response(pricing);
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <AuthContext.Provider value={authValue(['pricing.view'])}>
        <MemoryRouter><AdminPage /></MemoryRouter>
      </AuthContext.Provider>
    );

    const category = await screen.findByRole('tab', { name: /Браслети/ });
    expect(screen.queryByText('Структура каталогу')).toBeNull();
    fireEvent.click(category);

    const matrixCell = await screen.findByRole('textbox', { name: 'Круглий, Base' });
    expect(matrixCell.readOnly).toBe(true);
    expect(matrixCell.value).toBe('1250');
    expect(get).toHaveBeenCalledWith('/admin/prices/BR');
    expect(screen.queryByRole('button', { name: 'Дублювати сценарій' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Модифікатори' }));
    expect(await screen.findByText('Модифікатор ×1.2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Редагувати/ })).toBeNull();
  });

  it.each([
    ['Manager', ['corrections.view', 'corrections.reject']],
    ['Storekeeper', [
      'corrections.view',
      'corrections.claim',
      'corrections.complete',
      'corrections.reject',
    ]],
  ])('hides unavailable correction-processing controls for %s', async (label, permissions) => {
    const requests = [{
      id: 71,
      status: 'pending',
      sourceSku: 'BR1001',
      proposedSku: 'BR1002',
      categoryCode: 'BR',
      comment: '',
      changes: [],
      proposedPayload: { totalPriceUah: 1250 },
      createdAt: '2026-09-10T10:00:00.000Z',
      updatedAt: '2026-09-10T10:00:00.000Z',
    }, {
      id: 72,
      status: 'in_progress',
      sourceSku: 'BR2001',
      proposedSku: 'BR2002',
      categoryCode: 'BR',
      comment: '',
      changes: [],
      proposedPayload: { totalPriceUah: 1350 },
      claimFingerprint: 'other-browser',
      createdAt: '2026-09-10T10:00:00.000Z',
      updatedAt: '2026-09-10T10:00:00.000Z',
    }];
    vi.spyOn(api, 'get').mockImplementation(async (url) => (
      url === '/config'
        ? response(config)
        : response({ items: requests, summary: { active: 2, pending: 1, inProgress: 1 } })
    ));

    render(
      <AuthContext.Provider value={authValue(permissions)}>
        <MemoryRouter><CorrectionRequestsPage /></MemoryRouter>
      </AuthContext.Provider>
    );

    await screen.findByText('BR1001');
    expect(screen.getByRole('button', { name: 'Відхилити запит' })).toBeTruthy();
    expect(screen.queryByText('Примусово повернути')).toBeNull();
    if (label === 'Manager') {
      expect(screen.queryByText('Взяти в роботу')).toBeNull();
      expect(screen.queryByText('Підтвердити')).toBeNull();
    } else {
      expect(screen.getByText('Взяти в роботу')).toBeTruthy();
    }
  });
});
