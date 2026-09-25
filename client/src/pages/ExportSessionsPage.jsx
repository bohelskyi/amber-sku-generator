import { ArtifactTables } from '../components/export-templates/PreviewTable';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { exportSessionsApi as api } from '../api/export-sessions-api';
import { exportsApi } from '../api/exports-api';
import { ControlledExportOptions } from '../components/app/ControlledExportOptions';
import { PreviewSummary, ReadinessProblems, SnapshotFiles } from '../components/app/ExportTools';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation';
import { getApiError } from '../lib/http-error';
import { downloadBlob } from '../lib/download';
import { ExportWorkspaceShell } from '../components/workspace/ExportWorkspaceShell';
import { WorkspaceToolbar } from '../components/workspace/WorkspacePrimitives';
import { Notice } from '../components/app/UiPrimitives';

const freshSettings = () => ({ requestContract: 'template-v1', mode: 'new', selection: { mode: 'active' } });
const stateLabels = { prepared: 'Підготовлено — очікує явного створення', executing: 'Створення виконується', interrupted: 'Виконання перервано — можна повторити ту саму спробу', failed: 'Спроба завершилася помилкою', succeeded: 'Збережені файли готові', superseded: 'Спробу замінено', 'not-ready': 'Потрібні виправлення' };
function useLifetime() {
  const { principalLifetime } = useAuth(); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return useCallback(() => alive.current && principalLifetime?.valid !== false, [principalLifetime]);
}
function Settings({ value, onChange, disabled, canActivate }) {
  const update = (key, next) => onChange({ ...value, [key]: next });
  return <fieldset disabled={disabled} className="space-y-3">
    <label className="block">Назва експорту<input className="input" maxLength={160} value={value.title} onChange={(e) => update('title', e.target.value)} /></label>
    <label className="block">Діапазон<select className="input" value={value.settings.mode || 'manual'} onChange={(e) => update('settings', { ...value.settings, mode: e.target.value, fromSku: null, toSku: null })}>
      <option value="new">Нові товари після спільного курсора</option><option value="manual">Власний діапазон / повторний експорт</option>
    </select></label>
    {value.settings.mode === 'manual' && <div className="grid sm:grid-cols-2 gap-3">
      <label>Від SKU<input className="input" value={value.settings.fromSku || ''} onChange={(e) => update('settings', { ...value.settings, fromSku: e.target.value })} /></label>
      <label>До SKU (порожньо — до останнього)<input className="input" value={value.settings.toSku || ''} onChange={(e) => update('settings', { ...value.settings, toSku: e.target.value || null })} /></label>
    </div>}
    <ControlledExportOptions fixedMode templateMode templateSelection={value.settings.selection}
      setTemplateSelection={(selection) => update('settings', { ...value.settings, selection })} canActivate={canActivate} />
  </fieldset>;
}
function StoredResult({ id, canCreate, onDenied }) {
  const principalCurrent = useLifetime(); const accessible = useRef(true); const seenEpoch = useRef(null);
  const current = useCallback(() => principalCurrent() && accessible.current, [principalCurrent]);
  const [snapshot, setSnapshot] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const loading = useRef(false);
  const read = useCallback(async () => {
    if (!current()) return;
    try {
      const { data } = await exportsApi.getSnapshot(id); if (!current()) return;
      if (seenEpoch.current !== null && seenEpoch.current !== data.accessEpoch) { accessible.current = false; setSnapshot(null); onDenied?.(); return; }
      seenEpoch.current = data.accessEpoch; setSnapshot(data);
    } catch (e) { if (!current()) return; if ([403,404].includes(e.response?.status)) { accessible.current = false; setSnapshot(null); onDenied?.(); } setError(getApiError(e)); }
  }, [id, current, onDenied]);
  useEffect(() => { const initial = window.setTimeout(() => { void read(); }, 0); const focus = () => { void read(); }; window.addEventListener('focus', focus); return () => { window.clearTimeout(initial); window.removeEventListener('focus', focus); }; }, [read]);
  const run = async (task) => {
    if (!current() || loading.current) return; loading.current = true; setBusy(true); setError('');
    try { await task(); } catch (e) { if (current()) { if ([403,404].includes(e.response?.status)) { accessible.current = false; setSnapshot(null); onDenied?.(); } setError(getApiError(e)); } }
    finally { loading.current = false; if (current()) setBusy(false); }
  };
  return <section className="card p-3 space-y-3">
    <p>Це незмінний збережений результат. Читання та завантаження нічого не підтверджують.</p>
    {snapshot?.template && <div className="text-sm"><p>Зафіксований шаблон: {snapshot.templateLabel?.displayName || 'Шаблон'} · v{snapshot.templateLabel?.versionNumber || '—'}</p><details><summary>Ідентифікатор публікації та хеш</summary><p className="break-all">{snapshot.template.versionId} · {snapshot.template.definitionHash}</p></details></div>}
    {error && <p role="alert">{error}</p>}
    {!snapshot ? <p role="status">{error ? 'Результат недоступний.' : 'Завантаження збереженого результату…'}</p> : <SnapshotFiles snapshot={snapshot} loading={busy} canConfirm={canCreate}
      onDownload={(group) => run(async () => {
        const response = await exportsApi.downloadMagentoArtifact(id, group); if (!current()) return;
        downloadBlob(new Blob([response.data], { type: 'text/csv;charset=utf-8;' }), snapshot.artifacts.find((a) => a.groupCode === group)?.fileName || `magento-${group}.csv`, { documentRef: document, urlApi: window.URL });
      })} onConfirm={() => run(async () => {
        if (!canCreate || !current()) return;
        await exportsApi.confirmSnapshot(id, snapshot.accessEpoch); if (current()) await read();
      })} />}
  </section>;
}
function NewSession({ canActivate, onCreated, register }) {
  const current = useLifetime(); const [value, setValue] = useState({ title: '', settings: freshSettings() }); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const [submitted, setSubmitted] = useState(false); const pending = useRef(null); const loading = useRef(false);
  const dirty = Boolean(value.title || value.settings.mode !== 'new' || value.settings.selection.mode !== 'active');
  const save = useCallback(async (openAfterSave = true) => {
    if (!current() || loading.current) return false;
    if (!value.title.trim()) { setError('Вкажіть назву експорту.'); return false; }
    if (!pending.current) { pending.current = { ...value, creationKey: crypto.randomUUID() }; setSubmitted(true); }
    loading.current = true; setBusy(true); setError('');
    try { const { data } = await api.create(pending.current); if (!current()) return false; if (openAfterSave) onCreated(data.id); return true; }
    catch (e) {
      if (current()) {
        if (e.response?.status === 422) { pending.current = null; setSubmitted(false); setError(getApiError(e)); }
        else setError(`${getApiError(e)} Повтор зберігає початкову назву, налаштування й ключ. Також перевірте «Мої експорти»: відповідь могла загубитися.`);
      }
      return false;
    }
    finally { loading.current = false; if (current()) setBusy(false); }
  }, [value, current, onCreated]);
  useEffect(() => { register({ dirty, busy, save: () => save(false), discard: () => setValue({ title: '', settings: freshSettings() }) }); }, [dirty, busy, save, register]);
  return <section className="card p-4 space-y-3"><h2 className="font-semibold">Створити свій експорт</h2>
    <p>Спочатку приватний: доступ маєте лише ви. Створення зберігає налаштування, але не створює файлів і не резервує товари.</p>
    <Settings value={value} onChange={setValue} canActivate={canActivate} disabled={busy || submitted} />
    {error && <p role="alert">{error}</p>}<button className="btn btn-primary px-3" disabled={busy} onClick={save}>{submitted ? 'Повторити створення цього експорту' : 'Створити приватний експорт'}</button>
  </section>;
}
function SessionDetail({ id, canCreate, canActivate, register, onLost }) {
  const principalCurrent = useLifetime(); const accessible = useRef(true);
  const current = useCallback(() => principalCurrent() && accessible.current, [principalCurrent]);
  const [session, setSession] = useState(null); const [value, setValue] = useState(null); const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [preview, setPreview] = useState(null); const [remoteChange, setRemoteChange] = useState(false);
  const [query, setQuery] = useState(''); const [recipients, setRecipients] = useState([]); const [recipient, setRecipient] = useState('');
  const [manualName, setManualName] = useState(null); const [expanded, setExpanded] = useState(false); const [showAll, setShowAll] = useState(false);
  const dirtyRef = useRef(false); const revisionRef = useRef(null); const membershipRef = useRef(null); const loading = useRef(false); const readTicket = useRef(0);
  const denied = useCallback(() => { if (current()) { accessible.current = false; readTicket.current++; setSession(null); setValue(null); setPreview(null); setRecipients([]); setManualName(null); setDirty(false); dirtyRef.current = false; onLost(); } }, [current, onLost]);
  const handleError = useCallback((e) => { if (!current()) return; if ([401,403,404].includes(e.response?.status)) denied(); else setError(getApiError(e)); }, [current, denied]);
  const refresh = useCallback(async () => {
    if (!current()) return; const ticket = ++readTicket.current;
    try {
      const { data } = await api.get(id); if (!current() || ticket !== readTicket.current) return;
      if (membershipRef.current !== null && membershipRef.current !== data.accessEpoch) { denied(); return; }
      membershipRef.current = data.accessEpoch;
      if (revisionRef.current !== null && revisionRef.current !== data.configurationRevision) setPreview(null);
      if (dirtyRef.current && revisionRef.current !== data.configurationRevision) setRemoteChange(true);
      if (!dirtyRef.current) { setValue({ title: data.title, settings: data.settings }); revisionRef.current = data.configurationRevision; }
      setSession(data);
    } catch (e) { if (ticket === readTicket.current) handleError(e); }
  }, [id, current, handleError, denied]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void refresh(); }, 0); const focus = () => { if (!loading.current) void refresh(); };
    const timer = window.setInterval(() => { if (!document.hidden && !loading.current) void refresh(); }, 10000);
    window.addEventListener('focus', focus); return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [refresh]);
  const run = useCallback(async (task, apply) => {
    if (!current() || loading.current) return false; loading.current = true; setBusy(true); setError('');
    try { const { data } = await task(); if (!current()) return false; apply?.(data); return true; }
    catch (e) { handleError(e); return false; }
    finally { loading.current = false; if (current()) setBusy(false); }
  }, [current, handleError]);
  const save = useCallback(() => {
    if (!session || !canCreate) return false;
    return run(() => api.save(id, { ...value, expectedRevision: revisionRef.current, expectedAccessEpoch: session.accessEpoch }), (data) => {
      readTicket.current++; dirtyRef.current = false; setDirty(false); setRemoteChange(false); revisionRef.current = data.configurationRevision;
      setValue({ title: data.title, settings: data.settings }); setSession({ ...session, ...data, attempt: null }); setPreview(null);
    });
  }, [session, canCreate, run, id, value]);
  const discard = useCallback(() => { if (!session) return; dirtyRef.current = false; setDirty(false); setRemoteChange(false); revisionRef.current = session.configurationRevision; setValue({ title: session.title, settings: session.settings }); }, [session]);
  useEffect(() => { register({ dirty, busy, save: canCreate ? save : null, discard }); }, [dirty, busy, save, discard, canCreate, register]);
  useEffect(() => { if (!dirty) return undefined; const warn = (e) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  if (!session || !value) return <p role="status">Завантаження експорту…</p>;
  const precondition = { expectedRevision: session.configurationRevision, expectedAccessEpoch: session.accessEpoch };
  const frozen = Boolean(session.snapshotId); const p = preview || session.attempt?.preview;
  const tableCurrent = !dirty && !remoteChange && (!p?.configurationRevision || p.configurationRevision === session.configurationRevision) && (!session.attempt?.preview?.tableFingerprint || session.attempt.preview.tableFingerprint === p?.tableFingerprint);
  const recovering = ['failed', 'interrupted'].includes(session.attempt?.state);
  const tableAvailable = !p?.tableFingerprint || p.artifacts?.every((a) => typeof a.csvContent === 'string');
  const prepare = (supersede = false) => run(() => api.prepare(id, { ...precondition, ...(preview?.tableFingerprint ? { expectedPreviewFingerprint: preview.tableFingerprint } : {}), ...(supersede ? { supersedeAttemptId: session.currentAttemptId } : {}) }), (a) => { if (!preview || a.preview?.tableFingerprint !== preview.tableFingerprint || a.preview?.artifacts?.every((item) => typeof item.csvContent === 'string')) setPreview(a.preview); void refresh(); });
  const memberAction = (body) => run(() => api.membership(id, { expectedAccessEpoch: session.accessEpoch, ...body }), () => { void refresh(); });
  return <section className="space-y-4">
    <div className="card p-4 space-y-3"><h2 className="text-xl font-semibold">{session.title}</h2>
      <p>Власник: {session.ownerName || session.ownerUserId} · {session.isOwner ? 'ваш експорт' : 'спільний експорт'} · збережена ревізія {session.configurationRevision}</p>
      <p role="status">{frozen ? 'Файли зафіксовано; діапазон і шаблон незмінні.' : session.executing ? 'Операція виконується; стан оновлюється.' : stateLabels[session.attempt?.state] || 'Налаштування збережено; файлів ще немає.'}</p>
      {session.attempt?.lastErrorCode && <p>Остання помилка: {session.attempt.lastErrorCode}. Повторіть ту саму спробу або явно підготуйте нову перевірку.</p>}
      {error && <p role="alert">{error}</p>}{remoteChange && <p role="alert">Інший учасник змінив експорт. Ваші локальні поля збережено; збереження старої ревізії буде відхилено. Відкиньте зміни явно, щоб прийняти серверну версію.</p>}
      {frozen ? <div className="rounded border p-3 space-y-2">
        <p>Зафіксований діапазон: {p?.range?.fromSku} — {p?.range?.resolvedToSku || p?.range?.toSku}.</p>
        <p>Опублікований шаблон: {p?.template?.displayName || 'Шаблон'} · v{p?.template?.versionNumber || '—'}</p>
        <details><summary>Походження результату</summary><p className="break-all">Версія: {p?.template?.versionId} · SHA-256 {p?.template?.definitionHash}</p></details>
        <p>Інший діапазон або шаблон потребує дії «Створити свій експорт».</p>
      </div> : <Settings value={value} disabled={busy || !canCreate || session.executing} canActivate={canActivate} onChange={(next) => { dirtyRef.current = true; setDirty(true); setValue(next); }} />}
      {dirty && <p>Незбережені зміни бачите лише ви.</p>}
      {!frozen && canCreate && <div className="flex flex-wrap gap-3">
        <button className="btn btn-primary px-3" disabled={busy || !dirty || session.executing} onClick={save}>Зберегти налаштування</button>
        {dirty && <button className="btn btn-outline px-3" disabled={busy} onClick={discard}>Відкинути локальні зміни</button>}
      </div>}
      <button className="underline" disabled={busy} onClick={refresh}>Оновити стан із сервера</button>
      {!frozen && <div className="flex flex-wrap gap-3">
        <button className="btn btn-outline px-3" disabled={busy || dirty || session.executing} onClick={() => run(() => api.preview(id), setPreview)}>Перевірити збережений діапазон (лише читання)</button>
        {canCreate && <button className="btn btn-outline px-3" disabled={busy || dirty || session.executing} onClick={() => prepare(Boolean(session.currentAttemptId))}>{session.currentAttemptId ? 'Явно оновити перевірку та замінити спробу' : 'Підготувати збережену спробу'}</button>}
        {canCreate && session.currentAttemptId && <button className="btn btn-primary px-3" disabled={busy || dirty || session.executing || (!recovering && (!tableCurrent || !tableAvailable))} onClick={() => run(() => api.generate(id, { ...precondition, attemptId: session.currentAttemptId }), () => { void refresh(); })}>
          {['failed','interrupted'].includes(session.attempt?.state) ? 'Повторити ту саму спробу' : 'Створити файли цієї спроби'}</button>}
      </div>}
      {recovering && <p>Повтор використовує початкову збережену спробу. Нова таблиця перевірки не замінює її; успішний результат буде прочитано зі знімка.</p>}
      <p className="text-xs">Підготовка зберігає доказ перевірки без резервування товарів. Лише «Створити файли» створює знімок та експозицію. Різні експорти можуть мати спільні товари; курсор один для всіх.</p>
      <details><summary>Посилання та ідентифікатори</summary><Link className="break-all underline" to={`/exports/sessions/${id}`}>{id}</Link><p className="break-all">Спроба: {session.currentAttemptId || '—'} · Знімок: {session.snapshotId || '—'}</p></details>
    </div>
    {!frozen && p && <div className="card">{!tableCurrent && <p role="alert">Таблиця застаріла для поточних налаштувань або збереженої спроби. Оновіть перевірку та явно підготуйте спробу.</p>}<ArtifactTables key={p.tableFingerprint} artifacts={p.artifacts} /><PreviewSummary preview={p} loading={busy} onRefresh={() => run(() => api.preview(id), setPreview)} />
      {p.errors?.length > 0 && <ReadinessProblems errors={p.errors} expanded={expanded} showAll={showAll} onToggle={() => setExpanded(!expanded)} onShowAll={() => setShowAll(true)}
        manualNameProduct={manualName} onEditName={canCreate ? setManualName : null} onCloseName={() => setManualName(null)} onSavedName={() => { setManualName(null); setPreview(null); }} translationSuggestionAvailable={false} />}
      {p.template && <div className="p-3 text-sm"><p>Опублікований шаблон: {p.template.displayName || 'Шаблон'} · v{p.template.versionNumber || '—'}</p><details><summary>Походження</summary><p className="break-all">Версія: {p.template.versionId} · SHA-256 {p.template.definitionHash}</p></details></div>}
    </div>}
    {session.snapshotId && <StoredResult key={session.snapshotId} id={session.snapshotId} canCreate={canCreate} onDenied={denied} />}
    <div className="card p-4 space-y-3"><h3 className="font-semibold">Учасники</h3><p>Власник: {session.ownerName || session.ownerUserId}</p>
      <ul className="space-y-2">{session.participants.map((m) => <li key={m.user_id}>{m.display_name || m.preferred_username || m.user_id} · {({ pending: 'запрошено', accepted: 'приєднався', revoked: 'доступ відкликано', left: 'вийшов', declined: 'відхилено' })[m.state]}
        {session.isOwner && canCreate && ['pending','accepted'].includes(m.state) && <button className="ml-3 underline" disabled={busy} onClick={() => memberAction({ action: 'revoke', userId: m.user_id, expectedMemberEpoch: m.epoch })}>Відкликати доступ</button>}</li>)}</ul>
      {!session.isOwner && <button className="btn btn-outline px-3" disabled={busy} onClick={() => run(() => api.membership(id, { action: 'leave', expectedAccessEpoch: session.accessEpoch }), denied)}>Вийти зі спільного експорту</button>}
      {session.isOwner && canCreate && <details><summary>Поділитися</summary><p className="mt-3">Запросіть конкретного користувача. Він має явно приєднатися; його права не зміняться.</p>
        <label className="block">Ім’я або логін одержувача<input className="input" maxLength={80} value={query} onChange={(e) => { setQuery(e.target.value); setRecipients([]); setRecipient(''); }} /></label>
        <button className="btn btn-outline px-3" disabled={busy || query.trim().length < 2} onClick={() => run(() => api.recipients(id, query), (data) => setRecipients(data.users))}>Знайти користувача</button>
        <label className="block">Одержувач<select className="input" value={recipient} onChange={(e) => setRecipient(e.target.value)}><option value="">Оберіть точного користувача</option>{recipients.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.preferred_username} · {u.preferred_username} · ID {u.id}</option>)}</select></label>
        <button className="btn btn-primary px-3" disabled={busy || !recipient} onClick={() => run(() => api.invite(id, { userId: recipient, expectedAccessEpoch: session.accessEpoch }), () => { setRecipients([]); setRecipient(''); void refresh(); })}>Надіслати запрошення в застосунку</button>
      </details>}
      <p className="text-xs">Відкликання закриває подальший доступ. Воно не видаляє вже завантажені файли.</p>
    </div>
  </section>;
}
function SessionWorkspace({ canCreate, canActivate, scope = 'owned', create = false }) {
  const current = useLifetime(); const { sessionId } = useParams();
  const location = useLocation(); const navigate = useNavigate();
  const [items, setItems] = useState([]); const [next, setNext] = useState(null);
  const [selected, setSelected] = useState(null); const [openedLifetime, setOpenedLifetime] = useState(0);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ dirty: false, busy: false });
  const [knownId, setKnownId] = useState(''); const [known, setKnown] = useState('');
  const listTicket = useRef(0); const cache = useRef({});
  // Openings belong to this mounted principal, never to history state or storage.
  const opened = useRef(new Set()); const requestedOpen = useRef(null);
  const register = useCallback((state) => setForm(state), []);
  const navigation = useDirtyNavigation(form);
  const listing = !sessionId && !create;
  const list = useCallback(async (after = '') => {
    if (!current()) return; const ticket = ++listTicket.current;
    try {
      const { data } = await api.list(scope, after);
      if (!current() || ticket !== listTicket.current) return;
      const entries = after ? [...(cache.current[scope]?.items || []), ...data.items] : data.items;
      cache.current[scope] = { ...cache.current[scope], items: entries, next: data.next };
      setItems(entries); setNext(data.next);
    } catch (e) { if (current() && ticket === listTicket.current) setError(getApiError(e)); }
  }, [scope, current]);
  useEffect(() => {
    if (!listing) return undefined;
    const ticketRef = listTicket;
    const initial = window.setTimeout(() => { void list(); }, 0);
    const focus = () => { void list(); }; window.addEventListener('focus', focus);
    return () => { ticketRef.current++; window.clearTimeout(initial); window.removeEventListener('focus', focus); };
  }, [list, listing]);
  useEffect(() => { if (!form.dirty) return undefined; const warn = (e) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [form.dirty]);
  const syncRoute = useEffectEvent(() => {
    setForm({ dirty: false, busy: false }); setKnown(''); setNotice(''); setError('');
    setOpenedLifetime((n) => n + 1);
    if (sessionId && requestedOpen.current === sessionId) opened.current.add(location.key);
    requestedOpen.current = null;
    setSelected(sessionId && opened.current.has(location.key) ? sessionId : null);
    const saved = cache.current[scope]; setItems(saved?.items || []); setNext(saved?.next || null);
    if (listing && saved?.scrollY != null) window.requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
  });
  useEffect(() => {
    // The router owns the address; one controller survives its local destinations.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    syncRoute();
  }, [location.key]);
  const open = useCallback((id) => {
    if (!current()) return;
    requestedOpen.current = id;
    navigate('/exports/sessions/' + encodeURIComponent(id), { state: { returnTo: scope === 'shared' || scope === 'invitations' ? '/exports/shared' : '/exports/sessions' } });
  }, [current, navigate, scope]);
  const { commit } = navigation;
  const created = useCallback((id) => commit(() => open(id)), [commit, open]);
  const lost = useCallback(() => {
    opened.current.clear(); setSelected(null); setKnown(''); setForm({ dirty: false, busy: false });
    setNotice('Доступ до цього експорту втрачено. Дані закрито; відкрийте доступний експорт через поточний обліковий запис.');
  }, []);
  const newOwn = () => navigation.request(() => navigate('/exports/new/template'));
  const respond = (invite, action) => navigation.request(async () => {
    if (!current()) return;
    try { await api.membership(invite.id, { action, expectedAccessEpoch: invite.accessEpoch }); if (!current()) return; if (action === 'accept') open(invite.id); else void list(); }
    catch (e) { if (current()) setError(getApiError(e)); }
  });
  const titles = { owned: 'Мої експорти', shared: 'Спільні зі мною', invitations: 'Запрошення' };
  const returnTo = location.state?.returnTo === '/exports/shared' ? '/exports/shared' : '/exports/sessions';
  return <div className="space-y-5">
    {navigation.prompt}
    {error && <Notice>{error}</Notice>}{notice && <Notice tone="warning">{notice}</Notice>}
    <WorkspaceToolbar label="Дії експорту">
      {(sessionId || create) && <Link className="underline" to={returnTo}>{returnTo === '/exports/shared' ? '← До спільних експортів' : '← До моїх експортів'}</Link>}
      {canCreate && <button className="btn btn-outline px-3" onClick={newOwn}>Створити свій експорт</button>}
      {listing && <button className="btn btn-outline px-3" onClick={() => { void list(); }}>Оновити список</button>}
    </WorkspaceToolbar>
    {listing && <section className="space-y-3" aria-label={titles[scope]}>
      <h2 className="text-xl font-semibold">{titles[scope]}</h2>
      {scope === 'invitations' && <p>Ваші поточні права: {canCreate ? 'читати, створювати файли та явно підтверджувати результат' : 'лише читати й завантажувати; створення та підтвердження недоступні'}. Приєднання не надає нових дозволів.</p>}
      {!items.length && <p>У цьому списку поки немає експортів.</p>}
      <ul className="divide-y divide-slate-200">{items.map((s) => <li key={s.id} className="py-3"><strong>{s.title}</strong><p>Власник: {s.ownerName || s.ownerUserId}</p>
        {scope === 'invitations' ? <div className="flex flex-wrap gap-3"><button className="underline" onClick={() => respond(s, 'accept')}>Приєднатися до експорту користувача {s.ownerName || s.ownerUserId}</button><button className="underline" onClick={() => respond(s, 'decline')}>Відхилити запрошення</button></div>
          : <>
            {s.configurationRevision && <p>Ревізія {s.configurationRevision} · {s.snapshotId ? 'Файли готові' : s.currentAttemptId ? 'Перевірку збережено' : 'Налаштування'}</p>}
            {s.template && <p>{s.template.displayName} · v{s.template.versionNumber}</p>}
            {s.createdAt && <p className="text-xs">Створено: {new Date(s.createdAt).toLocaleString('uk-UA')}</p>}
            <Link className="underline" to={'/exports/sessions/' + encodeURIComponent(s.id)} state={{ returnTo: scope === 'shared' ? '/exports/shared' : '/exports/sessions' }} onClick={(event) => {
              // Preserve native open-in-new-tab behavior; that tab explicitly opens through its account.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              cache.current[scope] = { ...cache.current[scope], scrollY: window.scrollY };
              requestedOpen.current = s.id;
            }}>Відкрити / продовжити {s.title}</Link>
          </>}</li>)}</ul>
      {next && <button className="underline" onClick={() => { void list(next); }}>Наступні експорти</button>}
    </section>}
    {sessionId && !selected && <button className="btn btn-outline px-3 break-all" onClick={() => navigation.request(() => open(sessionId))}>Відкрити експорт із посилання через мій обліковий запис</button>}
    {create && (canCreate ? <NewSession key={openedLifetime} canActivate={canActivate} onCreated={created} register={register} /> : <p>Немає дозволу на створення експорту. Доступні перегляд і завантаження.</p>)}
    {selected === sessionId && selected && <SessionDetail key={`${selected}:${openedLifetime}`} id={selected} canCreate={canCreate} canActivate={canActivate} register={register} onLost={lost} />}
    {!create && <details className="border-t pt-4"><summary>Відкрити відомий історичний знімок</summary><p className="my-3 text-sm">Потрібен точний ID. Невідомі операції, створені до збережених сесій, автоматично не зіставляються.</p>
      <label className="block">ID збереженого знімка<input className="input" value={knownId} maxLength={200} onChange={(e) => setKnownId(e.target.value)} /></label>
      <button className="btn btn-outline px-3" disabled={!knownId.trim()} onClick={() => navigation.request(() => { setForm({ dirty: false, busy: false }); setSelected(null); setOpenedLifetime((n) => n + 1); setKnown(knownId.trim()); })}>Прочитати знімок без підтвердження</button>
    </details>}
    {known && <StoredResult key={`${known}:${openedLifetime}`} id={known} canCreate={canCreate} onDenied={lost} />}
  </div>;
}
export default function ExportSessionsPage({ embedded = false, scope = 'owned', create = false }) {
  const { permissions, applicationUser } = useAuth();
  if (!permissions.includes('exports.view')) return <p>Немає дозволу на перегляд експорту</p>;
  const content = <SessionWorkspace key={`${applicationUser?.id}:${permissions.includes('exports.create')}`} scope={scope} create={create} canCreate={permissions.includes('exports.create')} canActivate={permissions.includes('export_templates.activate')} />;
  return embedded ? content : <ExportWorkspaceShell>{content}</ExportWorkspaceShell>;
}
