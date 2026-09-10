import { useCallback, useEffect, useMemo, useState } from 'react';
import { LockKeyhole, Plus, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { AppPageHeader, LoadingState, Notice, StatusBadge } from '../components/app/UiPrimitives.jsx';
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
  const [notice, setNotice] = useState('');

  const selectedRole = roles.find((role) => role.id === selectedRoleId) || null;
  const permissionGroups = useMemo(() => groupPermissions(permissions), [permissions]);
  const selectedPermissionCount = form.permissionKeys.length;

  const loadData = useCallback(async (preferredRoleId) => {
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
    setSelectedRoleId(nextSelected?.id ?? null);
    if (nextSelected) {
      setForm({
        displayName: nextSelected.displayName,
        description: nextSelected.description,
        permissionKeys: nextSelected.permissionKeys,
      });
    }
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

  const selectRole = (role) => {
    setSelectedRoleId(role.id);
    setForm({
      displayName: role.displayName,
      description: role.description,
      permissionKeys: role.permissionKeys,
    });
    setError('');
    setNotice('');
  };

  const startCreate = () => {
    setSelectedRoleId(null);
    setForm(EMPTY_FORM);
    setError('');
    setNotice('');
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

  const saveRole = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (!selectedRole) {
        const response = await api.post('/admin/roles', form);
        await loadData(response.data.role.id);
        setNotice('Роль створено.');
        return;
      }
      if (selectedRole.isProtected) return;

      const removedPermissionKeys = selectedRole.permissionKeys.filter(
        (key) => !form.permissionKeys.includes(key)
      );
      if (
        removedPermissionKeys.length > 0
        && selectedRole.activeAssignedUserCount > 0
        && !globalThis.confirm(
          `Ця зміна одразу видалить ${removedPermissionKeys.length} дозв. `
          + `Зачеплено активних користувачів: ${selectedRole.activeAssignedUserCount}. Продовжити?`
        )
      ) return;

      let currentRole = selectedRole;
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
      }

      if (!sameKeys(form.permissionKeys, currentRole.permissionKeys)) {
        const response = await api.put(`/admin/roles/${selectedRole.id}/permissions`, {
          permissionKeys: form.permissionKeys,
          expectedVersion: currentRole.version,
          expectedActiveAssignedUserCount: currentRole.activeAssignedUserCount,
        });
        currentRole = response.data.role;
      }
      await refreshIfSelfAffected(currentRole);
      await loadData(currentRole.id);
      setNotice('Роль оновлено.');
    } catch (requestError) {
      setError(getRoleManagementErrorMessage(requestError));
      if (requestError?.response?.status === 409) await loadData(selectedRole?.id);
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (role, action) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await api.post(`/admin/roles/${role.id}/${action}`, {
        expectedVersion: role.version,
      });
      await loadData(response.data.role.id);
      setNotice(action === 'deactivate' ? 'Роль деактивовано.' : 'Роль активовано.');
    } catch (requestError) {
      setError(getRoleManagementErrorMessage(requestError));
      if (requestError?.response?.status === 409) await loadData(role.id);
    } finally {
      setBusy(false);
    }
  };

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
        {notice && <Notice tone="success">{notice}</Notice>}

        {loading ? <LoadingState label="Завантажуємо ролі…" /> : (
          <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
            <section className="card h-fit space-y-3 p-4 sm:p-5 lg:sticky lg:top-[calc(var(--workspace-nav-height)+1rem)]">
              <button type="button" className="btn btn-primary w-full gap-2" onClick={startCreate}><Plus size={16} aria-hidden="true" />Створити роль</button>
              <div className="space-y-2" aria-label="Ролі">
                {roles.map((role) => (
                  <button key={role.id} type="button" aria-pressed={selectedRoleId === role.id} onClick={() => selectRole(role)} className={`role-list-item ${selectedRoleId === role.id ? 'is-selected' : ''}`}>
                    <div className="flex items-start justify-between gap-2"><span className="font-semibold text-slate-900">{role.displayName}</span>{role.isProtected && <LockKeyhole size={16} className="shrink-0 text-amber-700" aria-label="Захищена роль" />}</div>
                    <div className="mt-1 flex flex-wrap gap-1.5"><StatusBadge tone={role.status === 'active' ? 'success' : 'neutral'}>{role.status === 'active' ? 'Активна' : 'Деактивована'}</StatusBadge><StatusBadge>{roleTypeLabel(role)}</StatusBadge></div>
                    <div className="mt-2 text-xs text-slate-600">{role.permissionCount} дозволів · {role.assignedUserCount} користувачів</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="card space-y-5 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h2 className="text-xl font-semibold text-slate-900">{selectedRole ? selectedRole.displayName : 'Нова роль'}</h2>{selectedRole && <p className="mt-1 text-sm text-slate-500">Активних користувачів: {selectedRole.activeAssignedUserCount} · вимкнених: {selectedRole.disabledAssignedUserCount}</p>}</div>
                <div className="flex flex-wrap items-center gap-2"><StatusBadge tone="info">Обрано дозволів: {selectedPermissionCount}</StatusBadge>{selectedRole?.isProtected && <StatusBadge tone="warning"><ShieldCheck size={14} className="mr-1" aria-hidden="true" />Захищена</StatusBadge>}</div>
              </div>
              {selectedRole?.isProtected && <Notice tone="warning">Адміністратор — постійна захищена роль. Вона автоматично має всі наявні та майбутні дозволи.</Notice>}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium text-slate-700">Назва<input className="input-sm mt-1" value={form.displayName} disabled={busy || selectedRole?.isProtected} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} /></label>
                <label className="text-sm font-medium text-slate-700">Опис<input className="input-sm mt-1" value={form.description} disabled={busy || selectedRole?.isProtected} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
              </div>

              <div className="space-y-4">
                {permissionGroups.map((group) => (
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
                        return <label key={permission.key} className={`permission-option ${readOnly ? 'is-locked' : ''}`}><input type="checkbox" checked={form.permissionKeys.includes(permission.key)} disabled={busy || readOnly} onChange={() => togglePermission(permission)} /><span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-slate-800">{presentation.label}</span>{permission.reserved && <StatusBadge tone="warning">Лише Адміністратор</StatusBadge>}</span><span className="mt-0.5 block text-xs leading-5 text-slate-500">{presentation.description}</span><span className="permission-key">{permission.key}</span></span></label>;
                      })}
                    </div>
                  </fieldset>
                ))}
              </div>

              {!selectedRole?.isProtected && <div className="flex flex-wrap justify-between gap-3">
                <div>{selectedRole?.status === 'active' ? <button type="button" className="btn btn-danger" disabled={busy || selectedRole.assignedUserCount > 0} title={selectedRole.assignedUserCount > 0 ? 'Спочатку призначте користувачам інші ролі' : ''} onClick={() => void changeStatus(selectedRole, 'deactivate')}>Деактивувати</button> : selectedRole && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => void changeStatus(selectedRole, 'reactivate')}>Активувати</button>}</div>
                <button type="button" className="btn btn-primary" disabled={busy || !form.displayName.trim() || !form.description.trim()} onClick={() => void saveRole()}>{selectedRole ? 'Зберегти зміни' : 'Створити роль'}</button>
              </div>}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
