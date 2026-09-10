import { useCallback, useEffect, useMemo, useState } from 'react';
import { LockKeyhole, Plus, Shield, ShieldCheck } from 'lucide-react';
import { useAuth } from '../auth/auth-context.js';
import { api } from '../lib/api.js';
import {
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
    return <main className="app-page"><div className="mx-auto max-w-4xl px-4 py-8"><div className="card" role="alert">Недостатньо прав для керування ролями.</div></div></main>;
  }

  return (
    <main className="app-page">
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 pb-20 sm:px-6">
        <header className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-700">Доступ</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">Ролі та дозволи</h1><p className="mt-1 text-sm text-slate-500">Дозволи діють на наступний запит користувача.</p></div>
          <Shield size={32} className="text-amber-600" aria-hidden="true" />
        </header>

        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">{error}</div>}
        {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">{notice}</div>}

        {loading ? <div className="card text-sm text-slate-500">Завантажуємо ролі…</div> : (
          <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
            <section className="card space-y-3">
              <button type="button" className="btn btn-primary w-full gap-2" onClick={startCreate}><Plus size={16} aria-hidden="true" />Створити роль</button>
              <div className="space-y-2">
                {roles.map((role) => (
                  <button key={role.id} type="button" onClick={() => selectRole(role)} className={`w-full rounded-xl border p-3 text-left ${selectedRoleId === role.id ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-white'}`}>
                    <div className="flex items-start justify-between gap-2"><span className="font-semibold text-slate-900">{role.displayName}</span>{role.isProtected && <LockKeyhole size={16} className="text-amber-700" aria-label="Захищена роль" />}</div>
                    <div className="mt-1 text-xs text-slate-500">{roleTypeLabel(role)} · {role.status === 'active' ? 'Активна' : 'Деактивована'}</div>
                    <div className="mt-2 text-xs text-slate-600">Дозволів: {role.permissionCount} · Користувачів: {role.assignedUserCount}</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="card space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h2 className="text-xl font-semibold text-slate-900">{selectedRole ? selectedRole.displayName : 'Нова роль'}</h2>{selectedRole && <p className="mt-1 text-sm text-slate-500">Активних: {selectedRole.activeAssignedUserCount}; вимкнених: {selectedRole.disabledAssignedUserCount}</p>}</div>
                {selectedRole?.isProtected && <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900"><ShieldCheck size={15} />Захищена</span>}
              </div>
              {selectedRole?.isProtected && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Адміністратор є постійною захищеною роллю з усіма дозволами.</div>}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium text-slate-700">Назва<input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={form.displayName} disabled={busy || selectedRole?.isProtected} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} /></label>
                <label className="text-sm font-medium text-slate-700">Опис<input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" value={form.description} disabled={busy || selectedRole?.isProtected} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
              </div>

              <div className="space-y-4">
                {permissionGroups.map((group) => (
                  <fieldset key={group.key} className="rounded-xl border border-slate-200 p-4" disabled={busy || selectedRole?.isProtected}>
                    <legend className="px-2 text-sm font-semibold text-slate-900">{group.label}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {group.permissions.map((permission) => {
                        const locked = permission.reserved && !selectedRole?.isProtected;
                        return <label key={permission.key} className={`flex gap-3 rounded-lg p-2 ${locked ? 'bg-slate-100 text-slate-500' : 'hover:bg-slate-50'}`}><input type="checkbox" checked={form.permissionKeys.includes(permission.key)} disabled={busy || selectedRole?.isProtected || locked} onChange={() => togglePermission(permission)} /><span><span className="block text-sm font-medium">{permission.key}{locked ? ' · лише Адміністратор' : ''}</span><span className="block text-xs text-slate-500">{permission.description}</span></span></label>;
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
