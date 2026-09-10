import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, EmptyState, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
import { api } from '../lib/api.js';
import {
  getApplicationUserStatusLabel,
  getUserManagementErrorMessage,
  getUserRoleLabel,
} from '../lib/user-management.js';

const STATUS_TONES = Object.freeze({
  pending: 'warning',
  active: 'success',
  disabled: 'danger',
});

function getUserName(user) {
  return user.displayName || user.preferredUsername || `Користувач #${user.id}`;
}

function formatLastAuthenticated(value) {
  if (!value) return 'Ще не входив';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Невідомо';
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default function UsersPage() {
  const auth = useAuth();
  const canManageUsers = auth.permissions.includes('users.manage');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [roleSelections, setRoleSelections] = useState({});
  const [loading, setLoading] = useState(canManageUsers);
  const [busyUserId, setBusyUserId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const statusCounts = users.reduce((counts, user) => ({
    ...counts,
    [user.status]: (counts[user.status] || 0) + 1,
  }), {});

  const loadUsers = useCallback(async () => {
    const [usersResponse, rolesResponse] = await Promise.all([
      api.get('/admin/users'),
      api.get('/admin/users/roles'),
    ]);
    const nextUsers = Array.isArray(usersResponse.data?.users)
      ? usersResponse.data.users
      : [];
    const nextRoles = Array.isArray(rolesResponse.data?.roles)
      ? rolesResponse.data.roles
      : [];
    const availableRoleIds = new Set(nextRoles.map((role) => String(role.id)));
    setUsers(nextUsers);
    setRoles(nextRoles);
    setRoleSelections((current) => Object.fromEntries(nextUsers.map((user) => {
      const currentRole = current[user.id];
      const selectedRole = availableRoleIds.has(currentRole)
        ? currentRole
        : (availableRoleIds.has(String(user.role?.id)) ? String(user.role.id) : '');
      return [user.id, selectedRole];
    })));
  }, []);

  useEffect(() => {
    if (!canManageUsers) return undefined;
    let cancelled = false;
    const loadTimer = globalThis.setTimeout(() => {
      loadUsers()
        .catch((requestError) => {
          if (!cancelled) setError(getUserManagementErrorMessage(requestError));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(loadTimer);
    };
  }, [canManageUsers, loadUsers]);

  const runAction = async (user, requestAction, successMessage) => {
    setBusyUserId(user.id);
    setError('');
    setNotice('');
    try {
      await requestAction();
      if (user.id === auth.applicationUser?.id && typeof auth.refresh === 'function') {
        await auth.refresh();
      } else {
        await loadUsers();
        setNotice(successMessage);
      }
    } catch (requestError) {
      setError(getUserManagementErrorMessage(requestError));
    } finally {
      setBusyUserId(null);
    }
  };

  if (!canManageUsers) {
    return (
      <main className="app-page">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
          <div className="card p-5" role="alert">Недостатньо прав для керування користувачами.</div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 pb-20 sm:px-6">
        <AppPageHeader
          eyebrow="Доступ"
          title="Користувачі застосунку"
          description="Підтверджуйте доступ, призначайте роль і контролюйте стан облікових записів."
        />

        {error && <Notice>{error}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}

        {!loading && users.length > 0 && (
          <section className="card metric-strip grid-cols-1 sm:grid-cols-3" aria-label="Стани користувачів">
            {[
              ['Очікують підтвердження', statusCounts.pending || 0, 'text-amber-700'],
              ['Активні', statusCounts.active || 0, 'text-emerald-700'],
              ['Вимкнені', statusCounts.disabled || 0, 'text-rose-700'],
            ].map(([label, value, valueClass]) => (
              <div className="metric-strip-item last:border-b-0 sm:border-b-0" key={label}>
                <div className="metric-strip-label">{label}</div>
                <div className={`metric-strip-value ${valueClass}`}>{value}</div>
              </div>
            ))}
          </section>
        )}

        <section className="card overflow-hidden p-0">
          {loading ? (
            <LoadingState compact label="Завантажуємо користувачів…" />
          ) : users.length === 0 ? (
            <EmptyState compact>Користувачів не знайдено.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="dense-table w-full min-w-[880px] border-collapse text-left">
                <thead>
                  <tr className="table-head border-b border-slate-200">
                    <th className="table-cell">Користувач</th>
                    <th className="table-cell">Стан</th>
                    <th className="table-cell">Останній вхід</th>
                    <th className="table-cell">Роль</th>
                    <th className="table-cell text-right">Дії</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => {
                    const name = getUserName(user);
                    const selectedRole = roleSelections[user.id] || '';
                    const busy = busyUserId === user.id;
                    return (
                      <tr key={user.id} className="border-b border-slate-100 align-top last:border-0" aria-busy={busy || undefined}>
                        <td className="table-cell">
                          <div className="font-semibold text-slate-900">{name}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{user.preferredUsername || 'Без імені входу'}</div>
                        </td>
                        <td className="table-cell">
                          <StatusBadge tone={STATUS_TONES[user.status] || 'neutral'}>
                            {getApplicationUserStatusLabel(user.status)}
                          </StatusBadge>
                        </td>
                        <td className="table-cell text-sm text-slate-600">
                          {formatLastAuthenticated(user.lastAuthenticatedAt)}
                        </td>
                        <td className="table-cell">
                          <select
                            className="input-sm min-w-44"
                            aria-label={`Роль для ${name}`}
                            value={selectedRole}
                            onChange={(event) => setRoleSelections((current) => ({
                              ...current,
                              [user.id]: event.target.value,
                            }))}
                            disabled={busy}
                          >
                            <option value="" disabled>Оберіть роль</option>
                            {roles.map((role) => (
                              <option key={role.id} value={role.id}>{getUserRoleLabel(role)}</option>
                            ))}
                          </select>
                          <div className="mt-1 text-xs text-slate-500">
                            {user.status === 'pending'
                              ? 'Буде призначена після підтвердження'
                              : `Поточна: ${user.role ? getUserRoleLabel(user.role) : 'не призначена'}`}
                          </div>
                        </td>
                        <td className="table-cell">
                          <div className="flex flex-wrap justify-end gap-2">
                            {user.status === 'pending' && (
                              <button
                                type="button"
                                className="btn btn-primary btn-compact-md gap-2"
                                aria-label={`Підтвердити ${name}`}
                                disabled={busy || !selectedRole}
                                onClick={() => void runAction(
                                  user,
                                  () => api.post(`/admin/users/${user.id}/approve`, { roleId: Number(selectedRole) }),
                                  `Доступ для ${name} підтверджено.`
                                )}
                              >
                                <UserCheck size={15} aria-hidden="true" />Підтвердити
                              </button>
                            )}
                            {user.status !== 'pending' && Number(selectedRole) !== user.role?.id && (
                              <button
                                type="button"
                                className="btn btn-outline btn-compact-md gap-2"
                                aria-label={`Змінити роль для ${name}`}
                                disabled={busy || !selectedRole}
                                onClick={() => void runAction(
                                  user,
                                  () => api.put(`/admin/users/${user.id}/role`, {
                                    roleId: Number(selectedRole),
                                    expectedAssignmentId: user.currentAssignmentId,
                                  }),
                                  `Роль для ${name} оновлено.`
                                )}
                              >
                                <ShieldCheck size={15} aria-hidden="true" />Змінити роль
                              </button>
                            )}
                            {user.status === 'active' && (
                              <button
                                type="button"
                                className="btn btn-danger btn-compact-md gap-2"
                                aria-label={`Вимкнути доступ для ${name}`}
                                disabled={busy}
                                onClick={() => void runAction(
                                  user,
                                  () => api.post(`/admin/users/${user.id}/disable`, {}),
                                  `Доступ для ${name} вимкнено.`
                                )}
                              >
                                <UserX size={15} aria-hidden="true" />Вимкнути
                              </button>
                            )}
                            {user.status === 'disabled' && (
                              <button
                                type="button"
                                className="btn btn-primary btn-compact-md gap-2"
                                aria-label={`Увімкнути доступ для ${name}`}
                                disabled={busy || !selectedRole}
                                onClick={() => void runAction(
                                  user,
                                  () => api.post(`/admin/users/${user.id}/enable`, {
                                    roleId: Number(selectedRole),
                                    expectedAssignmentId: user.currentAssignmentId,
                                  }),
                                  `Доступ для ${name} увімкнено.`
                                )}
                              >
                                <UserCheck size={15} aria-hidden="true" />Увімкнути
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
