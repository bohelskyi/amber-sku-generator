import { ExportReview } from '../components/exports/ExportReview';
import { StoredResult } from '../components/exports/StoredResult';
import { WorkspaceDialog } from '../components/workspace/WorkspaceDialog';
import { subscribeExportReviewChanged } from '../lib/export-review-events';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { exportSessionsApi as api } from '../api/export-sessions-api';
import { ControlledExportOptions } from '../components/app/ControlledExportOptions';
import { ManualMagentoNameEditor } from '../components/app/ExportTools';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation';
import { getApiError } from '../lib/http-error';
import { ExportWorkspaceShell } from '../components/workspace/ExportWorkspaceShell';
import { WorkspaceToolbar } from '../components/workspace/WorkspacePrimitives';
import { Notice } from '../components/app/UiPrimitives';
import { ExportSessionList, ExportInvitations } from '../components/exports/ExportSessionList';
import { SessionSharing } from '../components/exports/SessionSharing';
import { participantCount, rangeText, sessionDisplayState, sessionRecipe } from '../lib/export-session-presentation';
import { useExportReviewView } from '../hooks/product/useExportReviewView';

const freshSettings = () => ({ requestContract: 'template-v1', mode: 'new', selection: { mode: 'active' } });
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
      <option value="new">Нові товари</option><option value="manual">Власний діапазон / повторний експорт</option>
    </select></label>
    {value.settings.mode === 'manual' && <div className="grid sm:grid-cols-2 gap-3">
      <label>Від SKU<input className="input" value={value.settings.fromSku || ''} onChange={(e) => update('settings', { ...value.settings, fromSku: e.target.value })} /></label>
      <label>До SKU (порожньо — до останнього)<input className="input" value={value.settings.toSku || ''} onChange={(e) => update('settings', { ...value.settings, toSku: e.target.value || null })} /></label>
    </div>}
    <ControlledExportOptions fixedMode templateMode templateSelection={value.settings.selection}
      setTemplateSelection={(selection) => update('settings', { ...value.settings, selection })} canActivate={canActivate} />
  </fieldset>;
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
        else setError(`${getApiError(e)} Повтор відновлює цей самий експорт. Також перевірте «Мої експорти»: відповідь могла загубитися.`);
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
  const viewMemory = useExportReviewView(id);
  const [sharing, setSharing] = useState(false); const [replace, setReplace] = useState(false);
  const [originalOperation, setOriginalOperation] = useState(null); const operation = useRef(null);
  const [productChanged, setProductChanged] = useState(() => Boolean(viewMemory.read()?.productChanged));
  const reviewTicket = useRef(0); const checking = useRef(false);
  const recovery = useRef(null);
  useEffect(() => {
    const target = recovery.current?.querySelector('.btn-primary:not([disabled])') || recovery.current?.querySelector('button:not([disabled])');
    target?.focus();
  }, [session?.id]);
  const [manualName, setManualName] = useState(null); const [reviewStale, setReviewStale] = useState(false);
  const { permissions } = useAuth();
  useEffect(() => subscribeExportReviewChanged((event) => { if (current()) { reviewTicket.current++; setReviewStale(true); if (event?.kind === 'product') setProductChanged(true); } }), [current]);
  const dirtyRef = useRef(false); const revisionRef = useRef(null); const membershipRef = useRef(null); const loading = useRef(false); const readTicket = useRef(0); const reading = useRef(false);
  const denied = useCallback(() => { if (current()) { accessible.current = false; readTicket.current++; reviewTicket.current++; viewMemory.clear(); setSession(null); setValue(null); setPreview(null); setSharing(false); setManualName(null); setDirty(false); dirtyRef.current = false; onLost(); } }, [current, onLost, viewMemory]);
  const handleError = useCallback((e) => {
    if (!current()) return;
    if ([401,403,404].includes(e.response?.status)) denied();
    else {
      if (['EXPORT_PREVIEW_STALE', 'EXPORT_PREVIEW_EXPIRED', 'NEW_EXPORT_RANGE_STALE'].includes(e.response?.data?.code)) setReviewStale(true);
      setError(getApiError(e));
    }
  }, [current, denied]);
  useEffect(() => {
    let live = true;
    const checkIdentity = async () => {
      if (!current() || !preview?.tableFingerprint || session?.snapshotId || dirty || busy || checking.current) return;
      checking.current = true;
      try {
        const { data } = await api.preview(id);
        if (live && current() && data.tableFingerprint !== preview.tableFingerprint) setReviewStale(true);
      } catch (e) {
        if (live && current()) { setReviewStale(true); if ([401,403,404].includes(e.response?.status)) handleError(e); }
      }
      finally { checking.current = false; }
    };
    window.addEventListener('focus', checkIdentity);
    return () => { live = false; window.removeEventListener('focus', checkIdentity); };
  }, [id, current, preview, session?.snapshotId, dirty, busy, handleError]);
  const refresh = useCallback(async () => {
    if (!current() || reading.current) return; const ticket = ++readTicket.current; reading.current = true;
    try {
      const { data } = await api.get(id); if (!current() || ticket !== readTicket.current) return;
      if (membershipRef.current !== null && membershipRef.current !== data.accessEpoch) { denied(); return; }
      membershipRef.current = data.accessEpoch;
      if (revisionRef.current !== null && revisionRef.current !== data.configurationRevision) { reviewTicket.current++; setPreview(null); }
      if (dirtyRef.current && revisionRef.current !== data.configurationRevision) setRemoteChange(true);
      if (!dirtyRef.current) { setValue({ title: data.title, settings: data.settings }); revisionRef.current = data.configurationRevision; }
      setSession(data);
    } catch (e) { if (ticket === readTicket.current) handleError(e); }
    finally { reading.current = false; }
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
      setValue({ title: data.title, settings: data.settings }); setSession({ ...session, ...data, attempt: null }); setPreview(null); reviewTicket.current++;
      operation.current = null; setOriginalOperation(null);
    }).then((ok) => { if (!ok) void refresh(); return ok; });
  }, [session, canCreate, run, id, value, refresh]);
  const discard = useCallback(() => { if (!session) return; dirtyRef.current = false; setDirty(false); setRemoteChange(false); revisionRef.current = session.configurationRevision; setValue({ title: session.title, settings: session.settings }); }, [session]);
  useEffect(() => { register({ dirty, busy, save: canCreate ? save : null, discard }); }, [dirty, busy, save, discard, canCreate, register]);
  useEffect(() => { if (!dirty) return undefined; const warn = (e) => { e.preventDefault(); e.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  if (!session || !value) return error ? <div className="space-y-3"><p role="alert">{error}</p><button className="btn btn-primary px-3" onClick={refresh}>Повторити відкриття експорту</button></div> : <p role="status">Завантаження експорту…</p>;
  const precondition = { expectedRevision: session.configurationRevision, expectedAccessEpoch: session.accessEpoch };
  const frozen = Boolean(session.snapshotId); const p = preview || session.attempt?.preview;
  const reviewCurrent = !reviewStale && !dirty && !remoteChange && (!p?.configurationRevision || p.configurationRevision === session.configurationRevision);
  const preparationMatches = !session.attempt?.preview?.tableFingerprint || session.attempt.preview.tableFingerprint === p?.tableFingerprint;
  const preparationIssue = session.attempt?.preparationIssue;
  const tableCurrent = reviewCurrent && preparationMatches && !preparationIssue;
  const recovering = Boolean(originalOperation) || ['failed', 'interrupted'].includes(session.attempt?.state);
  const tableAvailable = Boolean(preview) && Boolean(preview.review?.files || preview.artifacts?.every((a) => typeof a.csvContent === 'string'));
  const ready = tableAvailable && reviewCurrent && p?.representedCount > 0 && !p?.errors?.length;
  const check = () => {
    const ticket = ++reviewTicket.current;
    return run(() => api.preview(id), (data) => { if (ticket !== reviewTicket.current) return; setPreview(data); setReviewStale(false); setProductChanged(false); viewMemory.update({ productChanged: false }); });
  };
  const prepare = (supersede = false) => run(() => api.prepare(id, { ...precondition, ...(preview?.tableFingerprint ? { expectedPreviewFingerprint: preview.tableFingerprint } : {}), ...(supersede ? { supersedeAttemptId: session.currentAttemptId } : {}) }), (a) => {
    if (!preview || a.preview?.tableFingerprint !== preview.tableFingerprint || a.preview?.artifacts?.every((item) => typeof item.csvContent === 'string')) setPreview(a.preview);
    if (a.id) { operation.current = null; setOriginalOperation(null); } setReplace(false); void refresh();
  });
  const generate = () => {
    if (!operation.current) operation.current = { ...precondition, attemptId: session.currentAttemptId };
    setOriginalOperation(operation.current);
    return run(() => api.generate(id, operation.current), () => { void refresh(); });
  };
  const status = sessionDisplayState(session, { dirty, conflict: remoteChange, stale: reviewStale || Boolean(preparationIssue), preview: p, tableAvailable, preparationMatches, uncertain: Boolean(originalOperation) });
  return <section className="space-y-4">
    <header className="export-session-header">
      <div className="space-y-2"><h2>{session.title}</h2><span className="export-workspace-status" role="status">{status}</span>
        <p>Власник: {session.ownerName || 'Ім’я не вказано'} · {participantCount(session) > 1 ? 'Спільний експорт' : 'Приватний експорт'} · Учасників: {participantCount(session)}</p>
        <p className="text-sm text-slate-600">{sessionRecipe(session)}</p></div>
      <button className="btn btn-outline px-3" onClick={() => setSharing(true)}>{session.isOwner && canCreate ? 'Поділитися' : 'Учасники'}</button>
    </header>
    {error && <p role="alert">{error}</p>}
    {remoteChange && <div className="export-recovery" role="alert"><p>Інший учасник змінив експорт. Ваші локальні поля збережено. Відкиньте зміни явно, щоб прийняти серверну версію.</p>
      <details><summary>Новіші збережені налаштування</summary><p>{session.title}</p><p>{rangeText(session.settings)}</p><p>{sessionRecipe({ ...session, template: null, attempt: null, snapshot: null })}</p></details></div>}
    {!frozen && <>
      <details open={!session.currentAttemptId || dirty} className="space-y-3"><summary>Налаштування експорту · {rangeText(value.settings)}</summary><Settings value={value} disabled={busy || !canCreate || session.executing} canActivate={canActivate}
        onChange={(next) => { dirtyRef.current = true; setDirty(true); setValue(next); }} />
        {dirty && <p>Незбережені зміни бачите лише ви.</p>}
        {canCreate && dirty && <div className="flex flex-wrap gap-3"><button className="btn btn-primary px-3" disabled={busy || session.executing} onClick={save}>Зберегти налаштування</button>
          <button className="btn btn-outline px-3" disabled={busy} onClick={discard}>Відкинути локальні зміни</button></div>}
      </details>
      <section ref={recovery} aria-label="Відновлення" className="export-recovery space-y-3">
        {session.executing ? <p>{session.attempt?.state === 'executing' ? 'Сервер створює файли. Стан оновлюється; дочекайтеся результату.' : 'Сервер виконує дію з експортом. Дочекайтеся оновлення стану.'}</p>
          : recovering ? <p>Створення не завершено або відповідь не отримано. Повтор відновлює початкове створення цього експорту, навіть якщо ви вже переглянули новішу перевірку.</p>
            : session.currentAttemptId && !tableAvailable ? <p>Перевірку збережено. Перед першим створенням файлів перевірте товари й перегляньте актуальну таблицю.</p>
              : <p>Перевірте товари, збережіть перевірку та створіть файли окремою дією.</p>}
        {!preparationMatches && <p role="status">Збережена перевірка застаріла. Перегляньте актуальні товари та явно замініть збережену перевірку.</p>}
        {preparationIssue && <p role="status">{preparationIssue === 'expired' ? 'Термін збереженої перевірки минув.' : 'Збережену перевірку більше не можна використати.'} Оновіть перевірку та явно замініть її перед створенням файлів.</p>}
        {!preview && productChanged && <div role="status"><p>Дані товару змінено. Попередній перегляд застарів.</p><p>Оновіть перевірку, щоб продовжити роботу з актуальними проблемами.</p></div>}
        <div className="flex flex-wrap gap-3">
          {!session.executing && !preview && <button className={`btn ${!dirty && !recovering ? 'btn-primary' : 'btn-outline'} px-3`} disabled={busy || dirty} onClick={check}>{productChanged ? 'Оновити перевірку' : 'Перевірити товари'}</button>}
          {!session.executing && canCreate && ready && (!session.currentAttemptId || !preparationMatches || preparationIssue || recovering) && <button className={`btn ${!session.currentAttemptId ? 'btn-primary' : 'btn-outline'} px-3`} disabled={busy || dirty}
            onClick={() => session.currentAttemptId ? setReplace(true) : prepare()}>{session.currentAttemptId ? 'Оновити та замінити збережену перевірку' : 'Зберегти перевірку'}</button>}
          {!session.executing && canCreate && session.currentAttemptId && <button className="btn btn-primary px-3" disabled={busy || dirty || (!recovering && (!tableCurrent || !tableAvailable || !ready))} onClick={generate}>
            {recovering ? 'Повторити створення цього експорту' : 'Створити файли'}</button>}
          <button className="btn btn-outline px-3" disabled={busy} onClick={refresh}>Оновити стан із сервера</button>
        </div>
      </section>
    </>}
    {!frozen && preview && <div className="card">
      <ExportReview preview={{ ...p, checkedAt: p.checkedAt || session.attempt?.preparedAt }} stale={!reviewCurrent || !tableAvailable} busy={busy || dirty || session.executing}
        productChanged={productChanged} viewMemory={viewMemory} recoveryFocusBlocked={Boolean(manualName)} onRefresh={check} onEditName={canCreate ? setManualName : undefined}
        canDecode={permissions.includes('products.view') && permissions.includes('products.decode')} onHandoff={() => setReviewStale(true)} />
      {manualName && <WorkspaceDialog title="Назва товару Magento" onClose={() => setManualName(null)}><ManualMagentoNameEditor product={manualName}
        onClose={() => setManualName(null)} onSaved={() => { setManualName(null); setReviewStale(true); setProductChanged(true); }} translationSuggestionAvailable={false} /></WorkspaceDialog>}
    </div>}
    {session.snapshotId && <StoredResult key={session.snapshotId} id={session.snapshotId} canCreate={canCreate} onDenied={denied} />}
    {sharing && <SessionSharing session={session} canCreate={canCreate} busy={busy} error={error} run={run} refresh={refresh} onLeave={denied} onClose={() => setSharing(false)} />}
    {replace && <WorkspaceDialog title="Замінити збережену перевірку" busy={busy} onClose={() => setReplace(false)}>
      <h3 className="font-semibold">Використати нову перевірку для створення файлів?</h3><p>Початкова перевірка більше не використовуватиметься. Якщо результат попереднього створення невідомий, спочатку повторіть його або оновіть стан.</p>
      <button className="btn btn-primary px-3" disabled={busy} onClick={() => prepare(true)}>Замінити перевірку</button><button className="btn btn-outline px-3" disabled={busy} onClick={() => setReplace(false)}>Скасувати</button>
    </WorkspaceDialog>}
    <details><summary>Технічні подробиці</summary><Link className="break-all underline" to={`/exports/sessions/${id}`}>{id}</Link>
      <p className="break-all">Ревізія: {session.configurationRevision} · Спроба: {session.currentAttemptId || '—'} · Знімок: {session.snapshotId || '—'}</p>
      <p>Стан: {session.attempt?.state || '—'} · Код: {session.attempt?.lastErrorCode || '—'}</p></details>
  </section>;
}
function SessionWorkspace({ canCreate, canActivate, scope = 'owned', create = false }) {
  const current = useLifetime(); const { sessionId } = useParams();
  const location = useLocation(); const navigate = useNavigate();
  const [items, setItems] = useState([]); const [next, setNext] = useState(null);
  const [listBusy, setListBusy] = useState(false); const [responding, setResponding] = useState(false); const responseBusy = useRef(false);
  const [selected, setSelected] = useState(null); const [openedLifetime, setOpenedLifetime] = useState(0);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ dirty: false, busy: false });
  const [knownId, setKnownId] = useState(''); const [known, setKnown] = useState('');
  const listTicket = useRef(0); const listPending = useRef(null); const cache = useRef({});
  // Openings belong to this mounted principal, never to history state or storage.
  const opened = useRef(new Set()); const requestedOpen = useRef(null);
  const register = useCallback((state) => setForm(state), []);
  const navigation = useDirtyNavigation(form);
  const listing = !sessionId && !create;
  const list = useCallback(async (after = '') => {
    if (!current() || listPending.current === listTicket.current) return;
    const ticket = ++listTicket.current; listPending.current = ticket; setListBusy(true); setError('');
    try {
      const { data } = await api.list(scope, after);
      if (!current() || ticket !== listTicket.current) return;
      const entries = after ? [...(cache.current[scope]?.items || []), ...data.items] : data.items;
      cache.current[scope] = { ...cache.current[scope], items: entries, next: data.next };
      setItems(entries); setNext(data.next);
    } catch (e) { if (current() && ticket === listTicket.current) { setError(getApiError(e)); setItems([]); setNext(null); delete cache.current[scope]; } }
    finally { if (listPending.current === ticket) listPending.current = null; if (current() && ticket === listTicket.current) setListBusy(false); }
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
    opened.current.clear(); listTicket.current++; cache.current = {}; setItems([]); setNext(null); setListBusy(false);
    setSelected(null); setKnown(''); setKnownId(''); setForm({ dirty: false, busy: false });
    setNotice('Доступ до цього експорту втрачено. Дані закрито; відкрийте доступний експорт через поточний обліковий запис.');
  }, []);
  const newOwn = () => navigation.request(() => navigate('/exports/new/template'));
  const respond = (invite, action) => navigation.request(async () => {
    if (!current() || responseBusy.current) return;
    responseBusy.current = true; setResponding(true);
    try { await api.membership(invite.id, { action, expectedAccessEpoch: invite.accessEpoch }); if (!current()) return; if (action === 'accept') open(invite.id); else void list(); }
    catch (e) { if (current()) setError(getApiError(e)); }
    finally { responseBusy.current = false; if (current()) setResponding(false); }
  });
  const titles = { owned: 'Мої експорти', shared: 'Спільні зі мною', invitations: 'Запрошення' };
  const returnTo = location.state?.returnTo === '/exports/shared' ? '/exports/shared' : '/exports/sessions';
  return <div className="space-y-5">
    {navigation.prompt}
    {error && <Notice>{error}</Notice>}{notice && <Notice tone="warning">{notice}</Notice>}
    <WorkspaceToolbar label="Дії експорту">
      {(sessionId || create) && <Link className="underline" to={returnTo}>{returnTo === '/exports/shared' ? '← До спільних експортів' : '← До моїх експортів'}</Link>}
      {canCreate && <button className="btn btn-outline px-3" onClick={newOwn}>Створити свій експорт</button>}
      {listing && <button className="btn btn-outline px-3" disabled={listBusy} onClick={() => { void list(); }}>Оновити список</button>}
    </WorkspaceToolbar>
    {listing && <section className="space-y-3" aria-label={titles[scope]}>
      <h2 className="text-xl font-semibold">{titles[scope]}</h2>
      {listBusy && <p role="status">Завантаження списку…</p>}
      {!listBusy && !items.length && <p>У цьому списку поки немає експортів.</p>}
      {scope === 'invitations' ? <ExportInvitations items={items} canCreate={canCreate} busy={responding} onRespond={respond} />
        : <ExportSessionList items={items} scope={scope} onOpen={(event, id) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          cache.current[scope] = { ...cache.current[scope], scrollY: window.scrollY };
          requestedOpen.current = id;
        }} />}
      {next && <button className="underline" disabled={listBusy} onClick={() => { void list(next); }}>Наступні експорти</button>}
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
