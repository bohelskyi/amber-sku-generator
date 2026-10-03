import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, EmptyState, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
import { ConfirmDialog, Drawer, Pagination } from '../components/ui/index.js';
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
const PAGE_SIZE = 50;

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
  const [feedback, setFeedback] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [pageIndex, setPageIndex] = useState(0);
  const [disableConfirmation, setDisableConfirmation] = useState(null);
  const [roleChangeConfirmation, setRoleChangeConfirmation] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const statusCounts = users.reduce((counts, user) => ({
    ...counts,
    [user.status]: (counts[user.status] || 0) + 1,
  }), {});
  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('uk');
    return users.filter((user) => {
      const matchesStatus = statusFilter === 'all' || user.status === statusFilter;
      const matchesQuery = !normalizedQuery || [getUserName(user), user.preferredUsername, user.role?.displayName]
        .some((value) => String(value || '').toLocaleLowerCase('uk').includes(normalizedQuery));
      return matchesStatus && matchesQuery;
    });
  }, [query, statusFilter, users]);
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleUsers = filteredUsers.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE);
  const selectedUser = users.find((user) => user.id === selectedUserId) || null;
  const closeSelectedUser = () => {
    if (busyUserId || !selectedUser) return;
    setRoleSelections((current) => ({
      ...current,
      [selectedUser.id]: selectedUser.role?.id ? String(selectedUser.role.id) : '',
    }));
    setSelectedUserId(null);
  };

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
    setFeedback(null);
    try {
      await requestAction();
    } catch (requestError) {
      setError(getUserManagementErrorMessage(requestError));
      setBusyUserId(null);
      return;
    }

    try {
      if (user.id === auth.applicationUser?.id && typeof auth.refresh === 'function') await auth.refresh();
      else await loadUsers();
      setFeedback({ tone: 'success', title: successMessage });
    } catch (refreshError) {
      setFeedback({
        tone: 'warning',
        title: `${successMessage} Список не оновлено.`,
        message: getUserManagementErrorMessage(refreshError),
      });
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

        {!selectedUser && error && <Notice>{error}</Notice>}
        {!selectedUser && feedback && <Notice tone={feedback.tone} title={feedback.title}>{feedback.message}</Notice>}

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

        {!loading && users.length > 0 && <div className="card grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_220px]">
          <label className="relative text-sm font-medium text-slate-700">
            <span className="sr-only">Пошук користувача</span><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-slate-400" />
            <input className="input-sm pl-9" type="search" value={query} placeholder="Ім’я, логін або роль"
              aria-label="Пошук користувача" onChange={(event) => { setQuery(event.target.value); setPageIndex(0); }} />
          </label>
          <label className="text-sm font-medium text-slate-700"><span className="sr-only">Стан користувача</span>
            <select className="input-sm" aria-label="Стан користувача" value={statusFilter}
              onChange={(event) => { setStatusFilter(event.target.value); setPageIndex(0); }}>
              <option value="all">Усі стани</option><option value="pending">Очікують підтвердження</option>
              <option value="active">Активні</option><option value="disabled">Вимкнені</option>
            </select>
          </label>
        </div>}

        <section className="card overflow-hidden p-0">
          {loading ? (
            <LoadingState compact label="Завантажуємо користувачів…" />
          ) : users.length === 0 ? (
            <EmptyState compact>Користувачів ще немає.</EmptyState>
          ) : filteredUsers.length === 0 ? (
            <EmptyState compact>Користувачів за цими умовами не знайдено.</EmptyState>
          ) : <ul className="divide-y divide-slate-100" aria-label="Користувачі">
            {visibleUsers.map((user) => {
              const name = getUserName(user);
              return <li key={user.id}>
                <button type="button" className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_auto_minmax(150px,0.45fr)_auto] sm:px-5"
                  aria-label={`Відкрити ${name}`} aria-pressed={selectedUserId === user.id}
                  onClick={() => setSelectedUserId(user.id)}>
                  <span className="min-w-0"><span className="block truncate font-semibold text-slate-900">{name}</span><span className="block truncate text-xs text-slate-500">{user.preferredUsername || 'Без імені входу'}</span></span>
                  <StatusBadge tone={STATUS_TONES[user.status] || 'neutral'}>{getApplicationUserStatusLabel(user.status)}</StatusBadge>
                  <span className="hidden min-w-0 text-sm text-slate-600 sm:block">{user.role ? getUserRoleLabel(user.role) : 'Роль не призначена'}</span>
                  <span className="hidden text-xs text-slate-500 sm:block">{formatLastAuthenticated(user.lastAuthenticatedAt)}</span>
                </button>
              </li>;
            })}
          </ul>}
          {!loading && filteredUsers.length > 0 && <Pagination
            hasPrevious={safePageIndex > 0} hasNext={(safePageIndex + 1) * PAGE_SIZE < filteredUsers.length}
            onPrevious={() => setPageIndex((current) => Math.max(0, current - 1))}
            onNext={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
            summary={`${safePageIndex * PAGE_SIZE + 1}–${Math.min((safePageIndex + 1) * PAGE_SIZE, filteredUsers.length)} з ${filteredUsers.length}`}
          />}
        </section>
      </div>
      <Drawer open={Boolean(selectedUser)} title={selectedUser ? getUserName(selectedUser) : 'Користувач'}
        description="Доступ і роль користувача" side="right" busy={busyUserId === selectedUser?.id}
        onClose={closeSelectedUser}>
        {selectedUser && (() => {
          const name = getUserName(selectedUser);
          const selectedRoleId = roleSelections[selectedUser.id] || '';
          const selectedRole = roles.find((role) => String(role.id) === String(selectedRoleId));
          const busy = busyUserId === selectedUser.id;
          return <div className="space-y-5">
            {error && <Notice>{error}</Notice>}
            {feedback && <Notice tone={feedback.tone} title={feedback.title}>{feedback.message}</Notice>}
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Стан</dt><dd className="mt-1"><StatusBadge tone={STATUS_TONES[selectedUser.status] || 'neutral'}>{getApplicationUserStatusLabel(selectedUser.status)}</StatusBadge></dd></div>
              <div><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Останній вхід</dt><dd className="mt-1 text-slate-800">{formatLastAuthenticated(selectedUser.lastAuthenticatedAt)}</dd></div>
              <div className="sm:col-span-2"><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Поточна роль</dt><dd className="mt-1 text-slate-800">{selectedUser.role ? getUserRoleLabel(selectedUser.role) : 'Не призначена'}</dd></div>
            </dl>
            <label className="block text-sm font-medium text-slate-700">Роль
              <select className="input-sm mt-1" aria-label={`Роль для ${name}`} value={selectedRoleId}
                onChange={(event) => setRoleSelections((current) => ({ ...current, [selectedUser.id]: event.target.value }))} disabled={busy}>
                <option value="" disabled>Оберіть роль</option>
                {roles.map((role) => <option key={role.id} value={role.id}>{getUserRoleLabel(role)}</option>)}
              </select>
              <span className="mt-1 block text-xs text-slate-500">{selectedUser.status === 'pending' ? 'Цю роль буде призначено після підтвердження доступу.' : 'Зміна ролі набуде чинності після підтвердження.'}</span>
            </label>
            <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
              {selectedUser.status === 'pending' && <button type="button" className="btn btn-primary gap-2" aria-label={`Підтвердити ${name}`} disabled={busy || !selectedRoleId}
                onClick={() => void runAction(selectedUser, () => api.post(`/admin/users/${selectedUser.id}/approve`, { roleId: Number(selectedRoleId) }), `Доступ для ${name} підтверджено.`)}><UserCheck size={15} aria-hidden="true" />Підтвердити доступ</button>}
              {selectedUser.status !== 'pending' && Number(selectedRoleId) !== selectedUser.role?.id && <button type="button" className="btn btn-primary gap-2" aria-label={`Переглянути зміну ролі для ${name}`} disabled={busy || !selectedRole}
                onClick={() => setRoleChangeConfirmation({
                  user: selectedUser, name, roleId: Number(selectedRoleId), roleLabel: getUserRoleLabel(selectedRole),
                  currentRoleLabel: selectedUser.role ? getUserRoleLabel(selectedUser.role) : 'Не призначена',
                  expectedAssignmentId: selectedUser.currentAssignmentId,
                })}><ShieldCheck size={15} aria-hidden="true" />Переглянути зміну ролі</button>}
              {selectedUser.status === 'active' && <button type="button" className="btn btn-danger gap-2" aria-label={`Вимкнути доступ для ${name}`} disabled={busy}
                onClick={() => setDisableConfirmation({ user: selectedUser, name, roleLabel: selectedUser.role ? getUserRoleLabel(selectedUser.role) : 'не призначена' })}><UserX size={15} aria-hidden="true" />Вимкнути доступ</button>}
              {selectedUser.status === 'disabled' && <button type="button" className="btn btn-primary gap-2" aria-label={`Увімкнути доступ для ${name}`} disabled={busy || !selectedRoleId}
                onClick={() => void runAction(selectedUser, () => api.post(`/admin/users/${selectedUser.id}/enable`, { roleId: Number(selectedRoleId), expectedAssignmentId: selectedUser.currentAssignmentId }), `Доступ для ${name} увімкнено.`)}><UserCheck size={15} aria-hidden="true" />Увімкнути доступ</button>}
            </div>
          </div>;
        })()}
      </Drawer>
      <ConfirmDialog open={Boolean(roleChangeConfirmation)} title={`Змінити роль для «${roleChangeConfirmation?.name || ''}»?`}
        description={`Поточна роль: ${roleChangeConfirmation?.currentRoleLabel || '—'}. Нова роль: ${roleChangeConfirmation?.roleLabel || '—'}. Нові дозволи діятимуть з наступного запиту користувача.`}
        confirmLabel="Змінити роль" busy={busyUserId === roleChangeConfirmation?.user?.id}
        onClose={() => { if (!busyUserId) setRoleChangeConfirmation(null); }} onConfirm={() => {
          const target = roleChangeConfirmation;
          if (!target) return;
          void runAction(target.user, () => api.put(`/admin/users/${target.user.id}/role`, {
            roleId: target.roleId,
            expectedAssignmentId: target.expectedAssignmentId,
          }), `Роль для ${target.name} оновлено.`).finally(() => setRoleChangeConfirmation(null));
        }} />
      <ConfirmDialog open={Boolean(disableConfirmation)} title={`Вимкнути доступ для «${disableConfirmation?.name || 'користувача'}»?`}
        description={`Користувач одразу втратить доступ до робочих розділів. Поточна роль «${disableConfirmation?.roleLabel || 'не призначена'}» збережеться.`}
        confirmLabel="Вимкнути доступ" tone="danger" busy={busyUserId === disableConfirmation?.user?.id}
        onClose={() => { if (!busyUserId) setDisableConfirmation(null); }} onConfirm={() => {
          const target = disableConfirmation;
          if (!target) return;
          void runAction(target.user, () => api.post(`/admin/users/${target.user.id}/disable`, {}), `Доступ для ${target.name} вимкнено.`)
            .finally(() => setDisableConfirmation(null));
        }} />
    </main>
  );
}
