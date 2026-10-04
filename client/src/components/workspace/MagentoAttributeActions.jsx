import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { api } from '../../lib/api.js';
import { LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import { useDirtyNavigation } from '../../hooks/useDirtyNavigation.jsx';

const root = '/admin/magento-integration';
const settings = [['required', 'Обов’язкове заповнення'], ['visibleOnFront', 'Показувати на сторінці товару'],
  ['searchable', 'Використовувати в пошуку'], ['filterable', 'Фільтр у каталозі'], ['filterableInSearch', 'Фільтр у результатах пошуку']];
const scopeNames = { global: 'Спільне для всіх магазинів', website: 'Окреме для вебсайту', store: 'Окреме для мови магазину' };
const empty = () => ({ attributeCode: '', label: '', englishLabel: '', frontendInput: '', scope: '',
  required: '', visibleOnFront: '', searchable: '', filterable: '', filterableInSearch: '' });

function AttributeReceipt({ action, busy, onReconcile, onAssign, onReady }) {
  return <article className="space-y-2 border-t py-3" aria-label={`Результат: ${action.label || action.attributeCode}`}>
    <p><strong>{action.label || action.attributeCode}</strong>{action.attributeSet && ` → ${action.attributeSet.name}`}</p><p role="status">{action.message}</p>
    {action.canReconcile && <button type="button" className="btn btn-outline" disabled={busy} onClick={() => onReconcile(action.id)}>Перевірити результат</button>}
    {action.state === 'verified' && action.kind === 'attribute' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onAssign(action.attributeCode)}>Підключити до набору</button>}
    {action.state === 'verified' && action.kind === 'attribute_assignment' && onReady && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onReady(action)}>Налаштувати передачу характеристики</button>}
    {action.attributeProfile && <MagentoDetails summary="Збережені налаштування атрибута">{() => <dl className="grid gap-2 sm:grid-cols-2"><div><dt>Тип</dt><dd>{action.attributeProfile.frontend_input === 'text' ? 'Текст' : 'Вибір одного варіанта'}</dd></div><div><dt>Значення</dt><dd>{scopeNames[action.attributeProfile.scope]}</dd></div>{[['is_required', 'Обов’язкове'], ['is_visible_on_front', 'На сторінці товару'], ['is_searchable', 'У пошуку'], ['is_filterable', 'Фільтр каталогу'], ['is_filterable_in_search', 'Фільтр пошуку']].map(([key, name]) => <div key={key}><dt>{name}</dt><dd>{action.attributeProfile[key] ? 'Так' : 'Ні'}</dd></div>)}</dl>}</MagentoDetails>}
    <MagentoDetails summary="Технічні деталі дії">{() => <div className="text-xs break-words"><p>{action.attributeCode} · {action.id} · {action.state}</p>{action.kind === 'attribute_assignment' && <p>{action.state === 'verified' ? 'Підтверджено доступність атрибута в наборі.' : 'Доступність атрибута ще потрібно підтвердити.'} Magento REST не повертає розділ і порядок атрибута; їх розташування не вважається перевіреним.</p>}</div>}</MagentoDetails>
  </article>;
}

function AttributeWorkspace({ revision, categoryCode, initialAttributeCode = '', mode = 'create', onResourceChanged, onReady, onDirtyChange }) {
  const auth = useAuth();
  const allowed = isActualAdministrator(auth) && ['export_templates.manage', 'export_templates.publish'].every((key) => auth.permissions.includes(key));
  const eligible = allowed && revision?.state === 'draft';
  const [stage, setStage] = useState(mode === 'assign' ? 'assign' : 'create');
  const initialForm = { ...empty(), attributeCode: /^[a-z][a-z0-9_]{0,29}$/.test(initialAttributeCode) ? initialAttributeCode : '' };
  const [form, setForm] = useState(initialForm);
  const [attributeCode, setAttributeCode] = useState(initialAttributeCode);
  const approvedSets = [...new Set((revision?.bindings?.routes || []).filter((route) => route.enabled && route.reviewState === 'approved'
    && route.routeKey.split(/[.:]/)[0] === categoryCode && route.setId).map((route) => String(route.setId)))];
  const initialSet = approvedSets.length === 1 ? approvedSets[0] : '';
  const [setId, setSetId] = useState(initialSet); const [groupId, setGroupId] = useState(''); const [order, setOrder] = useState('');
  const [context, setContext] = useState(null); const [contextBusy, setContextBusy] = useState(false);
  const [actions, setActions] = useState([]); const [preview, setPreview] = useState(null);
  const [showCompletedForm, setShowCompletedForm] = useState(false);
  const [result, setResult] = useState(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0); const inFlight = useRef(false); const mounted = useRef(true);
  const [savedForm, setSavedForm] = useState(JSON.stringify(initialForm));
  const [savedAssignment, setSavedAssignment] = useState(JSON.stringify([initialAttributeCode, initialSet, '', '']));
  const dirty = JSON.stringify(form) !== savedForm || JSON.stringify([attributeCode, setId, groupId, order]) !== savedAssignment;
  const dirtyNavigation = useDirtyNavigation({ dirty, busy, discard: () => {
    setForm(JSON.parse(savedForm)); const [code, set, group, position] = JSON.parse(savedAssignment);
    setAttributeCode(code); setSetId(set); setGroupId(group); setOrder(position); setPreview(null);
  } });
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const base = { bindingRevisionId: revision?.id, expectedRevision: revision?.revision };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    api.get(`${root}/actions`, { signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) setActions(data.filter((item) => ['attribute', 'attribute_assignment'].includes(item.kind)));
    }).catch(() => { if (!controller.signal.aborted) setError('Не вдалося прочитати збережені дії з атрибутами.'); });
    return () => controller.abort();
  }, [eligible, reload]);
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    api.get(`${root}/attributes/context`, { params: { bindingRevisionId: revision.id, expectedRevision: revision.revision,
      ...(setId ? { attributeSetId: setId } : {}) }, signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) { setContext(data); setContextBusy(false); }
    }).catch((cause) => { if (!controller.signal.aborted) { setError(cause.response?.data?.error || 'Не вдалося перевірити набори та мови Magento.'); setContextBusy(false); } });
    return () => controller.abort();
  }, [eligible, revision?.id, revision?.revision, setId, reload]);
  const attributes = new Map((revision?.schema?.attributes || []).filter((item) => ['text', 'select'].includes(item.frontend_input) && [true, 1, '1'].includes(item.is_user_defined))
    .map((item) => [item.attribute_code, item.default_frontend_label || item.attribute_code]));
  for (const action of actions.filter((item) => item.kind === 'attribute' && item.state === 'verified')) attributes.set(action.attributeCode, action.label || action.attributeCode);
  if (result?.kind === 'attribute' && result.state === 'verified') attributes.set(result.attributeCode, result.label || result.attributeCode);
  const assigned = !contextBusy && context?.set?.id === Number(setId) && context.members?.some((item) => item.code === attributeCode);
  const reservedCreation = actions.some((item) => item.kind === 'attribute' && item.attributeCode === form.attributeCode && !['sealed', 'superseded'].includes(item.state));
  const reservedAssignment = actions.some((item) => item.kind === 'attribute_assignment' && item.attributeCode === attributeCode
    && item.attributeSet?.id === Number(setId) && !['sealed', 'superseded'].includes(item.state));
  const creationReady = context && form.label && form.attributeCode && form.frontendInput && form.scope
    && settings.every(([key]) => form[key] !== '') && (!context.englishStoreId || form.englishLabel)
    && (form.frontendInput !== 'text' || (form.filterable === 'false' && form.filterableInSearch === 'false')) && !reservedCreation;
  const assignmentReady = context?.set?.id === Number(setId) && attributeCode && groupId && Number(order) > 0 && !assigned && !reservedAssignment;
  const edit = (patch) => { setForm((value) => ({ ...value, ...patch })); setPreview(null); setError(''); };
  const selectStage = (next) => { setStage(next); setPreview(null); setError(''); };
  async function run(kind, command) {
    if (!eligible || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      const { data } = await api.post(`${root}/attributes/${kind}`, command);
      if (!mounted.current) return;
      if (kind.endsWith('preview')) setPreview({ ...data, command, stage });
      else {
        setPreview(null); setResult(data);
        if (kind === 'apply') setSavedForm(JSON.stringify(form));
        if (kind === 'assignment-apply') setSavedAssignment(JSON.stringify([attributeCode, setId, groupId, order]));
        setActions((current) => [data, ...current.filter((item) => item.id !== data.id)]);
        if (data.state === 'verified') dirtyNavigation.commit(() => onResourceChanged?.(data));
      }
    } catch (cause) {
      if (!mounted.current) return;
      setPreview(null); setError(cause.response?.data?.error || 'Дію не завершено. Перевірте збережений результат перед повторною дією.');
      const actionId = cause.response?.data?.details?.actionId;
      if (actionId) {
        try {
          const { data } = await api.get(`${root}/actions/${encodeURIComponent(actionId)}`);
          if (mounted.current) { setResult(data); setActions((current) => [data, ...current.filter((item) => item.id !== data.id)]);
            if (kind === 'apply') setSavedForm(JSON.stringify(form));
            if (kind === 'assignment-apply') setSavedAssignment(JSON.stringify([attributeCode, setId, groupId, order]));
          }
        } catch { if (mounted.current) setError('Результат надісланої дії поки недоступний. Оновіть збережені дії; не створюйте атрибут повторно.'); }
      }
    } finally { if (mounted.current) { inFlight.current = false; setBusy(false); } }
  }
  if (!allowed) return <Notice>Створення атрибутів і підключення до наборів доступні Адміністратору з дозволами керування та публікації інтеграції.</Notice>;
  if (!eligible) return <Notice>Спочатку підготуйте чернетку налаштувань цієї категорії.</Notice>;
  const completed = result?.state === 'verified' && result.kind === 'attribute_assignment';
  return <section className="space-y-4" aria-label="Атрибут Magento">
    {result && <AttributeReceipt action={result} busy={busy} onReconcile={(actionId) => run('reconcile', { actionId })} onAssign={(code) => { setAttributeCode(code); selectStage('assign'); }} onReady={onReady ? (action) => dirtyNavigation.request(() => onReady(action)) : undefined} />}
    {actions.filter((action) => action.id !== result?.id).length > 0 && <MagentoDetails summary="Збережені дії з атрибутами">{() => actions.filter((action) => action.id !== result?.id).map((action) => <AttributeReceipt key={action.id} action={action} busy={busy} onReconcile={(actionId) => run('reconcile', { actionId })} onAssign={(code) => { setAttributeCode(code); setShowCompletedForm(true); selectStage('assign'); }} onReady={onReady ? (result) => dirtyNavigation.request(() => onReady(result)) : undefined} />)}</MagentoDetails>}
    {completed && !showCompletedForm && <button type="button" className="btn btn-outline" onClick={() => setShowCompletedForm(true)}>Відкрити форми атрибутів</button>}
    <div hidden={completed && !showCompletedForm} className="space-y-4">
    <nav className="flex flex-wrap gap-2" aria-label="Етапи атрибута"><button type="button" className="btn btn-outline" aria-current={stage === 'create' ? 'step' : undefined} disabled={busy} onClick={() => selectStage('create')}>1. Новий атрибут</button><button type="button" className="btn btn-outline" aria-current={stage === 'assign' ? 'step' : undefined} disabled={busy} onClick={() => selectStage('assign')}>2. Підключення до набору</button></nav>
    {error && <Notice tone="error">{error} <button type="button" className="btn btn-outline" disabled={busy} onClick={() => { setPreview(null); setReload((value) => value + 1); }}>Оновити збережені дії</button></Notice>}
    {(!context || contextBusy) && <LoadingState label="Перевіряємо структуру Magento…" />}
    {stage === 'create' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (creationReady) run('preview', { ...base, ...form, ...Object.fromEntries(settings.map(([key]) => [key, form[key] === 'true'])) }); }}>
      <h3 className="font-semibold">Новий атрибут Magento</h3>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label>Назва українською<input className="input" required maxLength={255} value={form.label} onChange={(event) => edit({ label: event.target.value })} /></label>
        {context?.englishStoreId && <label>Назва англійською<input className="input" required maxLength={255} value={form.englishLabel} onChange={(event) => edit({ englishLabel: event.target.value })} /></label>}
        <label>Код атрибута<input className="input" required pattern="[a-z][a-z0-9_]{0,29}" maxLength={30} value={form.attributeCode} onChange={(event) => edit({ attributeCode: event.target.value })} /></label>
        <label>Тип значення<select className="input" required value={form.frontendInput} onChange={(event) => edit({ frontendInput: event.target.value })}><option value="">Оберіть тип</option><option value="text">Текст</option><option value="select">Вибір одного варіанта</option></select></label>
        <label>Значення для магазинів<select className="input" required value={form.scope} onChange={(event) => edit({ scope: event.target.value })}><option value="">Оберіть область</option>{Object.entries(scopeNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        {settings.map(([key, name]) => <label key={key}>{name}<select className="input" required value={form[key]} onChange={(event) => edit({ [key]: event.target.value })}><option value="">Оберіть</option><option value="false">Ні</option><option value="true">Так</option></select></label>)}
      </fieldset>
      {form.frontendInput === 'text' && (form.filterable === 'true' || form.filterableInSearch === 'true') && <Notice tone="warning">Для текстового атрибута виберіть «Ні» у фільтрах. Фільтрування підтримує вибір одного варіанта.</Notice>}
      <button className="btn btn-primary" disabled={busy || !creationReady}>Перевірити атрибут</button>
    </form>}
    {stage === 'assign' && <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (assignmentReady) run('assignment-preview', { ...base, attributeCode, attributeSetId: Number(setId), attributeGroupId: Number(groupId), sortOrder: Number(order) }); }}>
      <h3 className="font-semibold">Доступність атрибута для товарів</h3>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label>Атрибут<select className="input" required value={attributeCode} onChange={(event) => { setAttributeCode(event.target.value); setPreview(null); }}><option value="">Оберіть атрибут</option>{[...attributes].map(([code, name]) => <option key={code} value={code}>{name} · {code}</option>)}</select></label>
        <label>Набір атрибутів<select className="input" required value={setId} onChange={(event) => { setSetId(event.target.value); setGroupId(''); setPreview(null); setContextBusy(true); }}><option value="">Оберіть набір</option>{context?.sets?.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}</select></label>
        <label>Розділ у Magento<select className="input" required disabled={busy || contextBusy || !setId} value={groupId} onChange={(event) => { setGroupId(event.target.value); setPreview(null); }}><option value="">Оберіть розділ</option>{context?.groups?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>Порядок у розділі<input className="input" type="number" required min="1" max="100000" step="1" value={order} onChange={(event) => { setOrder(event.target.value); setPreview(null); }} /></label>
      </fieldset>
      {assigned && <Notice tone="success">Атрибут уже доступний у цьому наборі. {onReady && <button type="button" className="btn btn-primary" disabled={busy || contextBusy} onClick={() => {
        const next = () => onReady({ attributeCode, attributeSet: context.set, membershipObserved: true });
        if (JSON.stringify(form) === savedForm) dirtyNavigation.commit(next); else dirtyNavigation.request(next);
      }}>Налаштувати передачу характеристики</button>}</Notice>}
      <button className="btn btn-primary" disabled={busy || contextBusy || !assignmentReady}>Перевірити підключення</button>
    </form>}
    {preview && <section className="space-y-3 border-t pt-4" aria-label="Перевірені зміни атрибута">
      <h3 className="font-semibold">{preview.stage === 'create' ? `Створити «${preview.label}»` : `Підключити «${preview.label}» до «${preview.target.set.name}»`}</h3>
      {preview.stage === 'create' ? <><dl className="grid gap-2 sm:grid-cols-2"><div><dt>Тип</dt><dd>{form.frontendInput === 'text' ? 'Текст' : 'Вибір одного варіанта'}</dd></div><div><dt>Значення</dt><dd>{scopeNames[form.scope]}</dd></div>{settings.map(([key, name]) => <div key={key}><dt>{name}</dt><dd>{form[key] === 'true' ? 'Так' : 'Ні'}</dd></div>)}</dl><p>Атрибут створиться для простих товарів, без початкового значення та варіантів. Після створення потрібні підключення до набору й правила передачі.</p>{form.required === 'true' && <Notice tone="warning">Товари з цим атрибутом потребуватимуть заповнення. Ця дія не додає значення наявним товарам.</Notice>}<MagentoDetails summary="Інші параметри нового атрибута">{() => <p>Без HTML, редактора форматування, унікальності, порівняння, сортування, промоправил та колонок адміністративної таблиці. Лише прості товари. Набори та варіанти створюються окремо.</p>}</MagentoDetails></>
        : <><p>Розділ: {preview.target.group.name}. Порядок: {preview.body.sortOrder}.</p><p>Підключення встановлює вибраний розділ і порядок атрибута в цьому наборі.</p><p>Перевіряємо доступність точного атрибута в наборі. Ця дія не заповнює товари й не публікує відповідності.</p></>}
      <div className="flex gap-2"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(preview.stage === 'create' ? 'apply' : 'assignment-apply', { ...preview.command, previewToken: preview.previewToken })}>{preview.stage === 'create' ? 'Створити атрибут у Magento' : 'Підключити атрибут до набору'}</button><button type="button" className="btn btn-outline" disabled={busy} onClick={() => setPreview(null)}>Повернутися до змін</button></div>
    </section>}
    </div>
    {dirtyNavigation.prompt}
  </section>;
}

export default function MagentoAttributeActions(props) {
  const auth = useAuth();
  if (!isActualAdministrator(auth) || !['export_templates.manage', 'export_templates.publish'].every((key) => auth.permissions?.includes(key))) return <Notice>Створення атрибутів і підключення до наборів доступні Адміністратору з дозволами керування та публікації інтеграції.</Notice>;
  if (props.revision?.state !== 'draft') return <Notice>Спочатку підготуйте чернетку налаштувань цієї категорії.</Notice>;
  return <AttributeWorkspace key={`${props.revision?.id}:${props.revision?.revision}:${props.categoryCode || ''}:${props.initialAttributeCode || ''}:${props.mode || 'create'}`} {...props} />;
}
