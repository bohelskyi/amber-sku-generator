import { useCallback, useEffect, useMemo, useState } from 'react';
import { LockKeyhole, Plus, Search, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
import { ChangeSummary, ConfirmDialog, TechnicalDisclosure } from '../components/ui/index.js';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation.jsx';
import { api } from '../lib/api.js';
import {
  getPermissionPresentation,
  getRoleManagementErrorMessage,
  groupPermissions,
} from '../lib/role-management.js';

const EMPTY_FORM = Object.freeze({
  displayName: '',
  description: '',
  permissionKeys: [],
});

function sameKeys(left, right) {
  return [...left].sort().join('\n') === [...right].sort().join('\n');
}

function roleTypeLabel(role) {
  return role.isSystem ? 'Системна' : 'Користувацька';
}

function permissionLabel(permission) {
  const presentation = getPermissionPresentation(permission);
  return presentation.label === permission.key
    ? (permission.description || 'Додатковий дозвіл')
    : presentation.label;
}

export default function RolesPage() {
  const auth = useAuth();
  const canManageRoles = auth.permissions.includes('roles.manage');
  const [roles, setRoles] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(canManageRoles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [permissionQuery, setPermissionQuery] = useState('');
  const [permissionGroupFilter, setPermissionGroupFilter] = useState('all');

  const selectedRole = roles.find((role) => role.id === selectedRoleId) || null;
  const permissionGroups = useMemo(() => groupPermissions(permissions), [permissions]);
  const selectedPermissionCount = form.permissionKeys.length;
  const dirty = selectedRole
    ? !selectedRole.isProtected && (
      form.displayName.trim() !== selectedRole.displayName
      || form.description.trim() !== selectedRole.description
      || !sameKeys(form.permissionKeys, selectedRole.permissionKeys)
    )
    : Boolean(form.displayName.trim() || form.description.trim() || form.permissionKeys.length);
  const visiblePermissionGroups = useMemo(() => {
    const query = permissionQuery.trim().toLocaleLowerCase('uk');
    return permissionGroups
      .filter((group) => permissionGroupFilter === 'all' || group.key === permissionGroupFilter)
      .map((group) => ({
        ...group,
        permissions: group.permissions.filter((permission) => {
          if (!query) return true;
          const presentation = getPermissionPresentation(permission);
          return [presentation.label, presentation.description, permission.key]
            .some((value) => String(value || '').toLocaleLowerCase('uk').includes(query));
        }),
      }))
      .filter((group) => group.permissions.length > 0);
  }, [permissionGroupFilter, permissionGroups, permissionQuery]);
  const permissionChanges = useMemo(() => {
    const before = selectedRole?.permissionKeys || [];
    return {
      added: form.permissionKeys.filter((key) => !before.includes(key)),
      removed: before.filter((key) => !form.permissionKeys.includes(key)),
    };
  }, [form.permissionKeys, selectedRole]);
  const changeItems = useMemo(() => {
    const items = [];
    if (!selectedRole || form.displayName.trim() !== selectedRole.displayName) items.push({
      key: 'name', label: 'Назва', before: selectedRole?.displayName || 'Нова роль', after: form.displayName.trim() || 'Не вказано',
    });
    if (!selectedRole || form.description.trim() !== selectedRole.description) items.push({
      key: 'description', label: 'Опис', before: selectedRole?.description || 'Не вказано', after: form.description.trim() || 'Не вказано',
    });
    if (!selectedRole || !sameKeys(form.permissionKeys, selectedRole.permissionKeys)) items.push({
      key: 'permissions', label: 'Кількість дозволів', before: selectedRole?.permissionKeys.length ?? 0, after: form.permissionKeys.length,
    });
    return items;
  }, [form, selectedRole]);

  const loadData = useCallback(async (preferredRoleId, { replaceForm = true } = {}) => {
    const [rolesResponse, permissionsResponse] = await Promise.all([
      api.get('/admin/roles'),
      api.get('/admin/roles/permissions'),
    ]);
    const nextRoles = Array.isArray(rolesResponse.data?.roles) ? rolesResponse.data.roles : [];
    const nextPermissions = Array.isArray(permissionsResponse.data?.permissions)
      ? permissionsResponse.data.permissions
      : [];
    setRoles(nextRoles);
    setPermissions(nextPermissions);
    const nextSelected = nextRoles.find((role) => role.id === preferredRoleId)
      || nextRoles[0]
      || null;
    if (replaceForm) setSelectedRoleId(nextSelected?.id ?? null);
    if (replaceForm && nextSelected) {
      setForm({
        displayName: nextSelected.displayName,
        description: nextSelected.description,
        permissionKeys: nextSelected.permissionKeys,
      });
    }
    return { roles: nextRoles, permissions: nextPermissions, selectedRole: nextSelected };
  }, []);

  useEffect(() => {
    if (!canManageRoles) return undefined;
    let cancelled = false;
    const timer = globalThis.setTimeout(() => {
      loadData()
        .catch((requestError) => {
          if (!cancelled) setError(getRoleManagementErrorMessage(requestError));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [canManageRoles, loadData]);

  const applyRoleToForm = (role) => {
    setSelectedRoleId(role.id);
    setForm({
      displayName: role.displayName,
      description: role.description,
      permissionKeys: role.permissionKeys,
    });
    setError('');
    setFeedback(null);
    setConflict(null);
  };

  const applyCreateForm = () => {
    setSelectedRoleId(null);
    setForm(EMPTY_FORM);
    setError('');
    setFeedback(null);
    setConflict(null);
  };

  const discardChanges = () => {
    if (selectedRole) applyRoleToForm(selectedRole);
    else applyCreateForm();
  };

  const togglePermission = (permission) => {
    if (permission.reserved || selectedRole?.isProtected) return;
    setForm((current) => ({
      ...current,
      permissionKeys: current.permissionKeys.includes(permission.key)
        ? current.permissionKeys.filter((key) => key !== permission.key)
        : [...current.permissionKeys, permission.key],
    }));
  };

  const refreshIfSelfAffected = async (role) => {
    if (auth.roles?.some((currentRole) => currentRole.id === role.id)) {
      await auth.refresh?.();
    }
  };

  const replaceLocalRole = (role) => {
    setRoles((current) => current.some((item) => item.id === role.id)
      ? current.map((item) => item.id === role.id ? role : item)
      : [...current, role]);
    setSelectedRoleId(role.id);
  };

  const applySavedRole = (role) => {
    replaceLocalRole(role);
    setForm({
      displayName: role.displayName,
      description: role.description,
      permissionKeys: role.permissionKeys,
    });
  };

  const loadConflict = async (roleId, attemptedForm, metadataSaved) => {
    try {
      const result = await loadData(roleId, { replaceForm: false });
      const latestRole = result.roles.find((role) => role.id === roleId) || null;
      setConflict({ latestRole, attemptedForm, metadataSaved });
    } catch (refreshError) {
      setConflict({ latestRole: null, attemptedForm, metadataSaved });
      setFeedback({
        tone: 'warning',
        title: metadataSaved
          ? 'Назву й опис збережено, дозволи не збережено.'
          : 'Зміни не збережено через новішу версію ролі.',
        message: `Не вдалося завантажити актуальну версію: ${getRoleManagementErrorMessage(refreshError)}`,
      });
    }
  };

  const saveRole = async () => {
    setBusy(true);
    setError('');
    setFeedback(null);
    setConflict(null);
    const attemptedForm = {
      displayName: form.displayName,
      description: form.description,
      permissionKeys: [...form.permissionKeys],
    };
    let metadataSaved = false;
    let currentRole = selectedRole;
    try {
      if (!selectedRole) {
        const response = await api.post('/admin/roles', form);
        currentRole = response.data.role;
        applySavedRole(currentRole);
        try {
          await loadData(currentRole.id);
          setFeedback({ tone: 'success', title: 'Роль створено.' });
        } catch (refreshError) {
          setFeedback({
            tone: 'warning',
            title: 'Роль створено, але список не оновлено.',
            message: getRoleManagementErrorMessage(refreshError),
          });
        }
        return true;
      }
      if (selectedRole.isProtected) return false;
      if (
        form.displayName.trim() !== selectedRole.displayName
        || form.description.trim() !== selectedRole.description
      ) {
        const response = await api.patch(`/admin/roles/${selectedRole.id}`, {
          displayName: form.displayName,
          description: form.description,
          expectedVersion: currentRole.version,
        });
        currentRole = response.data.role;
        metadataSaved = true;
        replaceLocalRole(currentRole);
      }

      if (!sameKeys(form.permissionKeys, currentRole.permissionKeys)) {
        try {
          const response = await api.put(`/admin/roles/${selectedRole.id}/permissions`, {
            permissionKeys: form.permissionKeys,
            expectedVersion: currentRole.version,
            expectedActiveAssignedUserCount: currentRole.activeAssignedUserCount,
          });
          currentRole = response.data.role;
          replaceLocalRole(currentRole);
        } catch (requestError) {
          if (requestError?.response?.status === 409) {
            await loadConflict(selectedRole.id, attemptedForm, metadataSaved);
            if (!metadataSaved) setFeedback({
              tone: 'warning',
              title: 'Дозволи не збережено: на сервері є новіша версія ролі.',
              message: 'Ваші зміни залишилися у формі. Порівняйте їх з актуальною версією перед повторною спробою.',
            });
          } else if (metadataSaved) {
            setFeedback({
              tone: 'warning',
              title: 'Назву й опис збережено, дозволи не збережено.',
              message: getRoleManagementErrorMessage(requestError),
            });
          } else {
            setError(getRoleManagementErrorMessage(requestError));
          }
          return false;
        }
      }
      applySavedRole(currentRole);
      let refreshWarning = '';
      try {
        await refreshIfSelfAffected(currentRole);
      } catch (refreshError) {
        refreshWarning = `Поточні права не оновлено: ${getRoleManagementErrorMessage(refreshError)}`;
      }
      try {
        await loadData(currentRole.id);
      } catch (refreshError) {
        refreshWarning = [refreshWarning, `Список не оновлено: ${getRoleManagementErrorMessage(refreshError)}`]
          .filter(Boolean).join(' ');
      }
      setFeedback(refreshWarning
        ? { tone: 'warning', title: 'Роль оновлено, але дані на екрані не повністю оновлено.', message: refreshWarning }
        : { tone: 'success', title: 'Роль оновлено.' });
      return true;
    } catch (requestError) {
      if (requestError?.response?.status === 409 && selectedRole) {
        await loadConflict(selectedRole.id, attemptedForm, metadataSaved);
        setFeedback({
          tone: 'warning',
          title: 'Зміни не збережено: на сервері є новіша версія ролі.',
          message: 'Ваші зміни залишилися у формі. Порівняйте їх з актуальною версією перед повторною спробою.',
        });
      } else {
        setError(getRoleManagementErrorMessage(requestError));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const requestSaveRole = () => {
    if (conflict) return undefined;
    if (!selectedRole) return void saveRole();
    const removedPermissionKeys = selectedRole.permissionKeys.filter(
      (key) => !form.permissionKeys.includes(key)
    );
    if (removedPermissionKeys.length > 0 && selectedRole.activeAssignedUserCount > 0) {
      setConfirmation({ kind: 'permissions', role: selectedRole, removedCount: removedPermissionKeys.length });
      return undefined;
    }
    return void saveRole();
  };

  const changeStatus = async (role, action) => {
    setBusy(true);
    setError('');
    setFeedback(null);
    try {
      const response = await api.post(`/admin/roles/${role.id}/${action}`, {
        expectedVersion: role.version,
      });
      const changedRole = response.data.role;
      replaceLocalRole(changedRole);
      const successTitle = action === 'deactivate' ? 'Роль деактивовано.' : 'Роль активовано.';
      try {
        await loadData(changedRole.id);
        setFeedback({ tone: 'success', title: successTitle });
      } catch (refreshError) {
        setFeedback({ tone: 'warning', title: `${successTitle} Список не оновлено.`, message: getRoleManagementErrorMessage(refreshError) });
      }
    } catch (requestError) {
      setError(getRoleManagementErrorMessage(requestError));
      if (requestError?.response?.status === 409) {
        try { await loadData(role.id); } catch { /* primary error remains authoritative */ }
      }
    } finally {
      setBusy(false);
    }
  };

  // Saving can require a separate impact confirmation when permissions are removed.
  // Keep route/local transitions fail-closed: the operator stays to review and save, or explicitly discards.
  const dirtyNavigation = useDirtyNavigation({ dirty, discard: discardChanges, busy });

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!canManageRoles) {
    return <main className="app-page"><div className="mx-auto max-w-4xl px-4 py-8"><div className="card p-5" role="alert">Недостатньо прав для керування ролями.</div></div></main>;
  }

  return (
    <main className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 pb-20 sm:px-6">
        <AppPageHeader
          eyebrow="Доступ"
          title="Ролі та дозволи"
          description="Налаштуйте можливості ролей. Зміни діють з наступного запиту користувача."
        />

        {error && <Notice>{error}</Notice>}
        {feedback && <Notice tone={feedback.tone} title={feedback.title}>{feedback.message}</Notice>}
        {conflict && <Notice tone="warning" title="На сервері є новіша версія ролі">
          <p>Ваші зміни залишилися у формі. Актуальна версія: {conflict.latestRole
            ? `№${conflict.latestRole.version}, «${conflict.latestRole.displayName}», ${conflict.latestRole.permissionCount} дозволів.`
            : 'не вдалося завантажити.'}</p>
          {conflict.metadataSaved && <p className="mt-2">Команда зміни назви й опису завершилась успішно; команда зміни дозволів — ні. Звірте форму з актуальною версією.</p>}
          <p className="mt-2">Повторне збереження заблоковано, доки ви явно не завантажите актуальну версію.</p>
          {conflict.latestRole && <button type="button" className="btn btn-outline mt-3" onClick={() => applyRoleToForm(conflict.latestRole)}>Завантажити актуальну версію</button>}
          {!conflict.latestRole && selectedRole && <button type="button" className="btn btn-outline mt-3" disabled={busy} onClick={() => void loadConflict(selectedRole.id, conflict.attemptedForm, conflict.metadataSaved)}>Повторити завантаження</button>}
        </Notice>}

        {loading ? <LoadingState label="Завантажуємо ролі…" /> : (
          <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
            <section className="card h-fit overflow-hidden p-0 lg:sticky lg:top-[calc(var(--workspace-nav-height)+1rem)]">
              <div className="border-b border-slate-200 px-4 py-3 sm:px-5">
                <button type="button" className="btn btn-primary w-full gap-2" onClick={() => dirtyNavigation.request(applyCreateForm)}><Plus size={16} aria-hidden="true" />Створити роль</button>
              </div>
              <ul className="role-master-list" aria-label="Ролі">
                {roles.map((role) => (
                  <li key={role.id}>
                    <button type="button" aria-pressed={selectedRoleId === role.id} onClick={() => dirtyNavigation.request(() => applyRoleToForm(role))} className={`role-list-item ${selectedRoleId === role.id ? 'is-selected' : ''}`}>
                      <div className="flex items-start justify-between gap-2"><span className="font-semibold text-slate-900">{role.displayName}</span>{role.isProtected && <LockKeyhole size={16} className="shrink-0 text-amber-700" aria-label="Захищена роль" />}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"><StatusBadge tone={role.status === 'active' ? 'success' : 'neutral'}>{role.status === 'active' ? 'Активна' : 'Деактивована'}</StatusBadge><StatusBadge>{roleTypeLabel(role)}</StatusBadge><span className="text-xs text-slate-600">{role.permissionCount} дозволів · {role.assignedUserCount} користувачів</span></div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card space-y-5 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h2 className="text-xl font-semibold text-slate-900">{selectedRole ? selectedRole.displayName : 'Нова роль'}</h2>{selectedRole && <p className="mt-1 text-sm text-slate-500">Активних користувачів: {selectedRole.activeAssignedUserCount} · вимкнених: {selectedRole.disabledAssignedUserCount}</p>}</div>
                <div className="flex flex-wrap items-center gap-2"><StatusBadge tone="info">Обрано дозволів: {selectedPermissionCount}</StatusBadge>{selectedRole?.isProtected && <StatusBadge tone="warning"><ShieldCheck size={14} className="mr-1" aria-hidden="true" />Захищена</StatusBadge>}</div>
              </div>
              {selectedRole?.isProtected && <Notice tone="warning">Адміністратор — постійна захищена роль. Вона автоматично має всі наявні та майбутні дозволи.</Notice>}

              {dirty && <div className="space-y-2"><ChangeSummary title="Запропоновані зміни" items={changeItems} />
                {(permissionChanges.added.length > 0 || permissionChanges.removed.length > 0) && <div className="space-y-1 px-1 text-sm text-slate-700">
                  {permissionChanges.added.length > 0 && <p>Додаються: {permissionChanges.added.map((key) => permissionLabel(permissions.find((item) => item.key === key) || { key })).join(', ')}.</p>}
                  {permissionChanges.removed.length > 0 && <p>Вилучаються: {permissionChanges.removed.map((key) => permissionLabel(permissions.find((item) => item.key === key) || { key })).join(', ')}.</p>}
                </div>}
              </div>}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium text-slate-700">Назва<input className="input-sm mt-1" value={form.displayName} disabled={busy || selectedRole?.isProtected} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} /></label>
                <label className="text-sm font-medium text-slate-700">Опис<input className="input-sm mt-1" value={form.description} disabled={busy || selectedRole?.isProtected} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
              </div>

              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_220px]">
                <label className="relative text-sm font-medium text-slate-700"><span className="sr-only">Пошук дозволу</span><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-slate-400" /><input type="search" className="input-sm pl-9" aria-label="Пошук дозволу" placeholder="Назва або технічний ключ" value={permissionQuery} onChange={(event) => setPermissionQuery(event.target.value)} /></label>
                <label className="text-sm font-medium text-slate-700"><span className="sr-only">Група дозволів</span><select className="input-sm" aria-label="Група дозволів" value={permissionGroupFilter} onChange={(event) => setPermissionGroupFilter(event.target.value)}><option value="all">Усі групи</option>{permissionGroups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}</select></label>
              </div>

              <div className="space-y-4">
                {visiblePermissionGroups.map((group) => (
                  <fieldset key={group.key} className="permission-group" disabled={busy || selectedRole?.isProtected}>
                    <legend className="sr-only">{group.label}</legend>
                    <div className="permission-group-header flex flex-wrap items-start justify-between gap-2">
                      <div><h3 className="text-sm font-semibold text-slate-900">{group.label}</h3><p className="mt-0.5 text-xs text-slate-500">{group.description}</p></div>
                      <span className="text-xs font-medium tabular-nums text-slate-500">{group.permissions.filter((permission) => form.permissionKeys.includes(permission.key)).length} / {group.permissions.length}</span>
                    </div>
                    <div className="grid gap-px bg-slate-200 sm:grid-cols-2">
                      {group.permissions.map((permission) => {
                        const locked = permission.reserved && !selectedRole?.isProtected;
                        const presentation = getPermissionPresentation(permission);
                        const readOnly = Boolean(selectedRole?.isProtected || locked);
                        return <label key={permission.key} className={`permission-option ${readOnly ? 'is-locked' : ''}`}><input type="checkbox" checked={form.permissionKeys.includes(permission.key)} disabled={busy || readOnly} onChange={() => togglePermission(permission)} /><span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-slate-800">{permissionLabel(permission)}</span>{permission.reserved && <StatusBadge tone="warning">Лише Адміністратор</StatusBadge>}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{presentation.description}</span></span></label>;
                      })}
                    </div>
                  </fieldset>
                ))}
                {visiblePermissionGroups.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">Дозволів за цими умовами не знайдено.</p>}
              </div>

              <TechnicalDisclosure summary="Технічні ключі дозволів">
                <dl className="space-y-2 text-sm">{visiblePermissionGroups.flatMap((group) => group.permissions).map((permission) => <div key={permission.key} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.7fr)]"><dt>{permissionLabel(permission)}</dt><dd className="break-all font-mono text-xs">{permission.key}</dd></div>)}</dl>
              </TechnicalDisclosure>

              {!selectedRole?.isProtected && <div className="flex flex-wrap justify-between gap-3">
                <div>{selectedRole?.status === 'active' ? <button type="button" className="btn btn-danger" disabled={busy || selectedRole.assignedUserCount > 0} title={selectedRole.assignedUserCount > 0 ? 'Спочатку призначте користувачам інші ролі' : ''} onClick={() => dirtyNavigation.request(() => setConfirmation({ kind: 'deactivate', role: selectedRole }))}>Деактивувати</button> : selectedRole && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => dirtyNavigation.request(() => void changeStatus(selectedRole, 'reactivate'))}>Активувати</button>}</div>
                <button type="button" className="btn btn-primary" disabled={busy || Boolean(conflict) || !dirty || !form.displayName.trim() || !form.description.trim()} onClick={requestSaveRole}>{selectedRole ? 'Зберегти зміни' : 'Створити роль'}</button>
              </div>}
            </section>
          </div>
        )}
      </div>
      {dirtyNavigation.prompt}
      <ConfirmDialog
        open={confirmation?.kind === 'permissions'}
        title={`Змінити дозволи ролі «${confirmation?.role?.displayName || ''}»?`}
        description={`Збережена редакція ролі: ${confirmation?.role?.version || '—'}. Буде вилучено дозволів: ${confirmation?.removedCount || 0}. Зміна одразу вплине на ${confirmation?.role?.activeAssignedUserCount || 0} активних користувачів.`}
        confirmLabel="Змінити дозволи"
        tone="danger"
        busy={busy}
        onClose={() => { if (!busy) setConfirmation(null); }}
        onConfirm={() => { setConfirmation(null); void saveRole(); }}
      />
      <ConfirmDialog
        open={confirmation?.kind === 'deactivate'}
        title={`Деактивувати роль «${confirmation?.role?.displayName || ''}»?`}
        description="Деактивовану роль не можна буде призначити користувачам, доки її не активують знову."
        confirmLabel="Деактивувати роль"
        tone="danger"
        busy={busy}
        onClose={() => { if (!busy) setConfirmation(null); }}
        onConfirm={() => {
          const role = confirmation?.role;
          setConfirmation(null);
          if (role) void changeStatus(role, 'deactivate');
        }}
      />
    </main>
  );
}
