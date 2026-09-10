import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, UserCheck, UserRoundCog, UserX } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { api } from '../lib/api.js';
import {
  getApplicationUserStatusLabel,
  getUserManagementErrorMessage,
  getUserRoleLabel,
} from '../lib/user-management.js';

const STATUS_CLASSES = Object.freeze({
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  active: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  disabled: 'bg-rose-50 text-rose-800 ring-rose-200',
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
    const availableRoleKeys = new Set(nextRoles.map((role) => role.key));
    setUsers(nextUsers);
    setRoles(nextRoles);
    setRoleSelections((current) => Object.fromEntries(nextUsers.map((user) => {
      const currentRole = current[user.id];
      const selectedRole = availableRoleKeys.has(currentRole)
        ? currentRole
        : (availableRoleKeys.has(user.roleKey) ? user.roleKey : '');
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
          <div className="card" role="alert">Недостатньо прав для керування користувачами.</div>
        </div>
      </main>
    );
  }

  return (
    <main className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 pb-20 sm:px-6">
        <header className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Доступ</p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">Користувачі застосунку</h1>
            <p className="mt-1 text-sm text-slate-500">Підтвердження доступу та призначення вбудованих ролей.</p>
          </div>
          <UserRoundCog size={32} className="text-amber-600" aria-hidden="true" />
        </header>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">
            {notice}
          </div>
        )}

        <section className="card overflow-hidden p-0">
          {loading ? (
            <div className="p-6 text-sm text-slate-500">Завантажуємо користувачів…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="dense-table w-full min-w-[920px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
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
                      <tr key={user.id} className="border-b border-slate-100 align-top last:border-0">
                        <td className="table-cell">
                          <div className="font-semibold text-slate-900">{name}</div>
                          <div className="mt-0.5 text-xs text-slate-500">{user.preferredUsername || 'Без імені входу'}</div>
                        </td>
                        <td className="table-cell">
                          <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${STATUS_CLASSES[user.status] || 'bg-slate-50 text-slate-700 ring-slate-200'}`}>
                            {getApplicationUserStatusLabel(user.status)}
                          </span>
                        </td>
                        <td className="table-cell text-sm text-slate-600">
                          {formatLastAuthenticated(user.lastAuthenticatedAt)}
                        </td>
                        <td className="table-cell">
                          <select
                            className="min-h-10 min-w-44 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
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
                              <option key={role.key} value={role.key}>{getUserRoleLabel(role.key)}</option>
                            ))}
                          </select>
                          {user.hasMultipleBuiltInRoles && (
                            <div className="mt-1 text-xs text-rose-700">Призначено кілька ролей — виберіть одну.</div>
                          )}
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
                                  () => api.post(`/admin/users/${user.id}/approve`, { roleKey: selectedRole }),
                                  `Доступ для ${name} підтверджено.`
                                )}
                              >
                                <UserCheck size={15} aria-hidden="true" />Підтвердити
                              </button>
                            )}
                            {user.status !== 'pending' && selectedRole !== user.roleKey && (
                              <button
                                type="button"
                                className="btn btn-outline btn-compact-md gap-2"
                                aria-label={`Змінити роль для ${name}`}
                                disabled={busy || !selectedRole}
                                onClick={() => void runAction(
                                  user,
                                  () => api.put(`/admin/users/${user.id}/role`, { roleKey: selectedRole }),
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
                                  () => api.post(`/admin/users/${user.id}/enable`, { roleKey: selectedRole }),
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
                  {users.length === 0 && (
                    <tr><td className="table-cell text-slate-500" colSpan={5}>Користувачів не знайдено.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
