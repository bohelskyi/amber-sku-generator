import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { api } from '../../lib/api.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/i;
const revision = /^[1-9][0-9]{0,18}$/;
const text = (value) => typeof value === 'string' && Boolean(value.trim());
const optionalText = (value) => value === null || text(value);
const invalid = () => { throw new Error('Сервер повернув неповні дані задачі. Оновіть її стан.'); };
const definiteErrors = new Set(['INTEGRATION_TASK_REVISION_STALE', 'INTEGRATION_TASK_NOT_READY',
  'INTEGRATION_TASK_RESOLUTION_STALE', 'INTEGRATION_TASK_NOT_OPEN', 'ADMIN_PERMISSION_REVOKED',
  'INTEGRATION_TASK_ACCESS_DENIED', 'INTEGRATION_TASK_NOT_FOUND', 'VALIDATION_ERROR']);
const labels = { open: 'Потребує налаштування', resolved: 'Задачу вирішено', cancelled: 'Задачу скасовано' };
function validTask(value, expectedId) {
  if (!uuid.test(value?.id) || expectedId && value.id !== expectedId || !revision.test(value.revision)
    || !Object.hasOwn(labels, value.state) || !text(value.categoryCode) || !optionalText(value.categoryLabel)
    || !optionalText(value.questionKey) || !optionalText(value.questionLabel)
    || !optionalText(value.valueId) || !optionalText(value.valueLabel) || !text(value.reasonCode) || !text(value.message)
    || !text(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isSafeInteger(Number(value.createdBy?.id)) || Number(value.createdBy.id) <= 0
    || value.productCreationAllowedLocally !== true || value.deliveryAccepted !== false) invalid();
  return value;
}
function validList(value) {
  if (!Array.isArray(value?.items) || value.items.length > 20
    || value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0)) invalid();
  value.items.forEach((item) => validTask(item));
  if (new Set(value.items.map((item) => item.id)).size !== value.items.length) invalid();
  return value;
}
function repairLink(task) {
  if (typeof task.repairHref !== 'string' || !task.repairHref.startsWith('/') || task.repairHref.startsWith('//')) return null;
  try {
    const url = new URL(task.repairHref, 'https://amber.invalid');
    if (url.origin !== 'https://amber.invalid' || url.pathname !== '/admin/magento/prepare' || url.hash
      || url.searchParams.getAll('category').length !== 1 || url.searchParams.get('category') !== task.categoryCode
      || url.searchParams.getAll('returnTo').length !== 1 || url.searchParams.get('returnTo') !== '/attention?integrationTask=' + task.id) return null;
    for (const [key, value] of [['question', task.questionKey], ['value', task.valueId]]) {
      if (value !== null ? url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value : url.searchParams.has(key)) return null;
    }
    return task.repairHref;
  } catch { return null; }
}
function resumeLink(task) { return task.resumeHref === '/products/create?integrationTask=' + task.id ? task.resumeHref : null; }
function context(task) {
  return 'Новий незбережений товар · ' + (task.categoryLabel || task.categoryCode) + (task.questionKey ? ' · ' + (task.questionLabel || 'Характеристика') : '')
    + (task.valueId !== null ? ' · ' + (task.valueLabel || 'Обране значення') : '');
}
const message = (error, fallback) => typeof error?.response?.data?.error === 'string' ? error.response.data.error : fallback;

export default function IntegrationTaskQueue({ selectedTaskId, onSelectTask, refreshKey = 0, apiClient = api }) {
  const auth = useAuth();
  const owner = auth.principalLifetime;
  const administrator = isActualAdministrator(auth) && auth.permissions.includes('export_templates.manage');
  const canCreate = auth.permissions.includes('products.create');
  const canRead = (administrator || canCreate) && owner?.valid !== false;
  const scope = administrator ? 'administrator' : 'creator';
  const [localSelection, setLocalSelection] = useState(null);
  const selected = selectedTaskId === undefined ? localSelection : selectedTaskId;
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState(null), [detail, setDetail] = useState(null), [refresh, setRefresh] = useState(0);
  const [resolution, setResolution] = useState(null), [acknowledged, setAcknowledged] = useState(false);
  const [operation, setOperation] = useState(null), [uncertain, setUncertain] = useState(null), [operationError, setOperationError] = useState(null);
  const current = useRef({ owner, scope, canRead, administrator, selected });
  const mounted = useRef(true), flight = useRef(null), card = useRef(null);
  useLayoutEffect(() => { current.current = { owner, scope, canRead, administrator, selected }; }, [owner, scope, canRead, administrator, selected]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ownerMatches = (ticket, requireAdmin = false) => mounted.current && current.current.owner === ticket.owner
    && current.current.scope === ticket.scope && current.current.canRead && ticket.owner?.valid !== false
    && (!requireAdmin || current.current.administrator);
  const selectedMatches = (ticket, requireAdmin = false) => ownerMatches(ticket, requireAdmin) && current.current.selected === ticket.id;
  useEffect(() => { if (canRead && selected && uuid.test(selected)) card.current?.focus(); }, [canRead, selected]);
  const resourceMatches = (value) => Boolean(value && value.owner === owner && value.scope === scope);
  useEffect(() => {
    if (!canRead) return undefined;
    let live = true;
    const controller = new AbortController(), ticket = { owner, scope };
    apiClient.get('/integration-tasks', { params: { state: 'open', offset, limit: 20 }, signal: controller.signal })
      .then(({ data }) => { const value = validList(data); if (live && current.current.owner === owner && current.current.scope === scope && current.current.canRead && owner?.valid !== false) setList({ ...ticket, offset, value }); })
      .catch((error) => { if (live && current.current.owner === owner && current.current.scope === scope && current.current.canRead && owner?.valid !== false) setList({ ...ticket, offset, unavailable: error?.response?.status === 404, error: 'Не вдалося прочитати задачі інтеграції.' }); });
    return () => { live = false; controller.abort(); };
  }, [apiClient, owner, scope, canRead, offset, refresh, refreshKey]);
  useEffect(() => {
    if (!canRead || !selected || !uuid.test(selected)) return undefined;
    let live = true;
    const controller = new AbortController(), ticket = { owner, scope, id: selected };
    apiClient.get('/integration-tasks/' + selected, { signal: controller.signal }).then(({ data }) => {
      const value = validTask(data, selected);
      if (live && current.current.owner === owner && current.current.scope === scope && current.current.canRead && owner?.valid !== false) {
        setDetail((previous) => previous?.owner === owner && previous.scope === scope && previous.id === selected
          && previous.value && BigInt(previous.value.revision) > BigInt(value.revision) ? previous : { ...ticket, value });
        if (value.state !== 'open') setUncertain((previous) => previous?.owner === owner && previous.id === selected ? null : previous);
      }
    }).catch((error) => { if (live && current.current.owner === owner && current.current.scope === scope && current.current.canRead && owner?.valid !== false) setDetail({ ...ticket, error: error?.response?.status === 404 ? 'Задачу не знайдено. Це не підтверджує результат попередньої спроби.' : 'Не вдалося прочитати вибрану задачу.' }); });
    return () => { live = false; controller.abort(); };
  }, [apiClient, owner, scope, canRead, selected, refresh, refreshKey]);
  const page = resourceMatches(list) && list.offset === offset ? list : null;
  const taskResource = resourceMatches(detail) && detail.id === selected ? detail : null;
  const task = taskResource?.value;
  const checked = resourceMatches(resolution) && resolution.id === selected && task?.revision === resolution.revision ? resolution : null;
  const busy = resourceMatches(operation) ? operation.kind : '';
  const unknown = resourceMatches(uncertain) && uncertain.id === selected;
  const error = resourceMatches(operationError) && operationError.id === selected ? operationError.message : null;
  const canConfirm = administrator && !busy && !unknown && checked?.value?.resolved === true && hash.test(checked.value.resolutionToken) && task.state === 'open';
  function select(id) { if (onSelectTask) onSelectTask(id); else setLocalSelection(id); }
  function begin(kind) {
    if (!administrator || !task || task.state !== 'open' || flight.current || unknown
      || !selectedMatches({owner,scope,id:task.id},true)) return null;
    const ticket = { owner, scope, id: task.id, revision: task.revision, kind };
    flight.current = ticket; setOperation(ticket); setOperationError(null); return ticket;
  }
  function finish(ticket) {
    if (flight.current === ticket) flight.current = null;
    if (mounted.current) setOperation((previous) => previous === ticket ? null : previous);
  }
  async function recheck() {
    const ticket = begin('recheck'); if (!ticket) return;
    setResolution(null); setAcknowledged(false);
    try {
      const { data } = await apiClient.get('/integration-tasks/' + ticket.id + '/resolution');
      if (data?.taskId !== ticket.id || data.revision !== ticket.revision || typeof data.resolved !== 'boolean'
        || data.resolutionToken !== null && !hash.test(data.resolutionToken) || !data.readiness || typeof data.readiness !== 'object') invalid();
      if (selectedMatches(ticket, true)) setResolution({ ...ticket, value: data });
    } catch (cause) { if (selectedMatches(ticket)) setOperationError({ ...ticket, message: message(cause, 'Не вдалося перевірити поточні налаштування. Попередня перевірка не використовуватиметься.') }); }
    finally { finish(ticket); }
  }
  async function resolveTask() {
    if (!canConfirm || !acknowledged) return;
    const ticket = begin('resolve'); if (!ticket) return;
    const payload = { expectedRevision: ticket.revision, resolutionToken: checked.value.resolutionToken };
    setResolution(null); setAcknowledged(false);
    try {
      const { data } = await apiClient.post('/integration-tasks/' + ticket.id + '/resolve', payload);
      const value = validTask(data, ticket.id); if (value.state !== 'resolved' || BigInt(value.revision) <= BigInt(ticket.revision)) invalid();
      if (selectedMatches(ticket, true)) { setDetail({ ...ticket, value }); setRefresh((number) => number + 1); }
      else if (ownerMatches(ticket)) setUncertain(ticket);
    } catch (cause) {
      if (mounted.current && current.current.owner === owner && owner?.valid !== false) {
        if (definiteErrors.has(cause?.response?.data?.code)) {
          setOperationError({ ...ticket, message: message(cause, 'Підтвердження не прийнято. Прочитайте чинний стан і повторіть перевірку налаштування.') });
          setRefresh((number) => number + 1);
        } else setUncertain(ticket);
      }
    }
    finally { finish(ticket); }
  }
  if (!canRead) return selected ? <p role="alert">Перегляд цієї задачі інтеграції недоступний для вашого рівня доступу.</p> : null;
  return <section className="integration-task-queue rounded border border-slate-200 p-4" aria-label="Задачі налаштування інтеграції">
    <header className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Задачі Адміністратору</h2><button type="button" className="btn btn-outline" onClick={() => setRefresh((number) => number + 1)}>Оновити задачі</button></header>
    <p className="mt-2 text-sm">{administrator ? 'Задачі з точним контекстом товару, характеристики та значення.' : 'Ваші задачі налаштування. Введені дані товару залишаються у вашій спробі створення.'}</p>
    {page?.unavailable ? <p className="mt-2" role="status">Задачі інтеграції ще недоступні на сервері. Це не означає, що задач немає.</p> : page?.error ? <p className="mt-2" role="alert">{page.error}</p> : !page ? <p className="mt-2" role="status">Читаємо задачі…</p> : <>
      {!page.value.items.length && <p className="mt-2">Відкритих задач інтеграції немає.</p>}
      <details className="mt-3" open={!selected}><summary className="min-h-[34px] cursor-pointer py-2">Відкриті задачі ({page.value.items.length})</summary>
      <ul className="mt-3 grid gap-2">{page.value.items.map((item) => <li key={item.id}><button type="button" className="btn btn-outline w-full min-w-0 whitespace-normal break-words text-left" aria-pressed={selected === item.id} onClick={() => select(item.id)}>
        <span className="min-w-0"><strong>{context(item)}</strong><span className="block text-sm">{item.message}</span></span>
      </button></li>)}</ul>
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn btn-outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>Попередні задачі</button><button type="button" className="btn btn-outline" disabled={page.value.nextOffset === null} onClick={() => setOffset(page.value.nextOffset)}>Наступні задачі</button></div>
      </details>
    </>}
    {selected && !uuid.test(selected) && <p className="mt-3" role="alert">Номер задачі у посиланні некоректний.</p>}
    {selected && uuid.test(selected) && <article ref={card} tabIndex={-1} className="mt-4 rounded border border-slate-300 p-3" aria-label="Вибрана задача інтеграції">
      <button type="button" className="btn btn-outline" onClick={() => select(null)}>До списку задач</button>
      {!taskResource ? <p className="mt-2" role="status">Читаємо точну задачу…</p> : taskResource.error ? <p role="alert">{taskResource.error}</p> : <>
        <h3 className="mt-3 font-semibold">{context(task)}</h3><p className="mt-1 font-semibold">{labels[task.state]}</p><p className="mt-2">{task.message}</p>
        <p className="mt-2 text-sm">Автор: {typeof task.createdBy.displayName === 'string' ? task.createdBy.displayName : 'Користувач'}. Створено: {new Date(task.createdAt).toLocaleString('uk-UA')}.</p>
        <p className="mt-2">Товар можна зберегти локально за його чинною перевіркою. Ця задача не підтверджує доставку в Magento.</p>
        {administrator && task.state === 'open' && !repairLink(task) && <p className="mt-2" role="alert">Посилання на точне налаштування не підтверджено. Оновіть стан задачі.</p>}
        {Number.isInteger(task.creationContext?.photoCount) && <p className="mt-2">Фото зі спроби створення: {task.creationContext.photoCount}.</p>}
        {Array.isArray(task.creationContext?.unavailablePhotoIds) && task.creationContext.unavailablePhotoIds.length > 0 && <p className="mt-2" role="alert">Фото зі спроби вже недоступні: {task.creationContext.unavailablePhotoIds.length}. Після повернення перегляньте фото перед перевіркою та збереженням товару.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {administrator && repairLink(task) && <a className="btn btn-primary" href={repairLink(task)}>Відкрити точне налаштування</a>}
          {canCreate && resumeLink(task) && <a className="btn btn-outline" href={resumeLink(task)}>Повернутися до створення товару</a>}
          {administrator && task.state === 'open' && <button type="button" className="btn btn-outline" disabled={Boolean(busy || unknown)} onClick={() => void recheck()}>Перевірити результат налаштування</button>}
        </div>
        {checked?.value && <div className="mt-3 rounded border p-3" role="status">
          <p>{checked.value.resolved ? hash.test(checked.value.resolutionToken) ? 'Поточна перевірка дозволяє підтвердити вирішення цієї задачі.' : 'Перевірка не повернула підтвердження для завершення задачі. Оновіть її стан.' : 'Поточні налаштування ще не усунули причину задачі.'}</p>
          {canConfirm && <><label className="mt-2 flex min-h-[34px] items-center gap-2"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}/>Підтверджую лише вирішення цієї задачі за перевіреними налаштуваннями.</label><button type="button" className="btn btn-primary mt-2" disabled={!acknowledged} onClick={() => void resolveTask()}>Позначити задачу вирішеною</button></>}
          <p className="mt-2 text-sm">Це локальний запис задачі. Публікація правил і доставка товару перевіряються окремо.</p>
        </div>}
        {unknown && <p className="mt-3" role="alert">Результат вирішення ще не підтверджено. Оновіть стан цієї самої задачі; повторне підтвердження не надсилатиметься.</p>}
        {task.state === 'resolved' && <p className="mt-3">Задачу вирішено за перевіркою налаштувань. Поверніться до товару й оновіть його перевірку; доставки в Magento це не підтверджує.</p>}
        {error && <p className="mt-3" role="alert">{error}</p>}
      </>}
    </article>}
  </section>;
}
