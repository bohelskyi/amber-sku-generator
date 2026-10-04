import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link, useLocation, useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useAuth } from '../../auth/auth-context.js';
import { isActualAdministrator } from '../../auth/auth-model.js';
import { exportTemplatesApi as templates } from '../../api/export-templates-api.js';
import { useDirtyNavigation } from '../../hooks/useDirtyNavigation.jsx';
import { COLUMN_CONTRACT, columnChange } from '../../lib/export-template-columns.js';
import { at, summary } from '../../lib/export-template-presentation.js';
import { assertCategoryScope, changedFields, decisionKey, deliveryPolicies, routeLabel, rulesIdentity, uniqueOptionSuggestions } from '../../lib/magento-category-workspace.js';
import { ColumnInspector } from '../export-templates/ColumnInspector.jsx';
import { SampleProducts } from '../export-templates/SampleProducts.jsx';
import { ArtifactTables } from '../export-templates/PreviewTable.jsx';
import { WorkspaceDialog } from './WorkspaceDialog.jsx';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import MagentoPublicationActions from './MagentoPublicationActions.jsx';
import MagentoControlledActions from './MagentoControlledActions.jsx';
import MagentoProductChecks from './MagentoProductChecks.jsx';
import MagentoWorkspaceReview from './MagentoWorkspaceReview.jsx';
import '../export-templates/export-template-editor.css';
import './magento-category-workspace.css';

const root = '/admin/magento-integration';
const date = (value) => value ? new Date(value).toLocaleString('uk-UA') : 'Спостереження відсутнє';
const messages = { unmapped: 'Не передається', connected: 'Підключено', review: 'Потребує перевірки' };
const fail = (cause) => cause.response?.data?.error || cause.message || 'Дію не завершено. Введені зміни збережено у формі.';
const scopeParams = ['category', 'binding', 'source', 'ruleDraft', 'route', 'language', 'field', 'view'];
const scopeIdentity = (categoryCode, params) => JSON.stringify([categoryCode, ...scopeParams.map((key) => params.get(key))]);

function FieldSurface({ overlay, children, busy, suspended, onClose }) {
  return overlay ? <WorkspaceDialog title="Поле Magento" className="mc-field-dialog" busy={busy} suspended={suspended} onClose={onClose}><div className="mc-editor">{children}</div></WorkspaceDialog>
    : <div className="mc-editor">{children}</div>;
}

function SampleResult({ preview }) {
  return <section aria-label="Результат прикладу" className="space-y-2">
    <p>Сервер обчислив приклад: готові {preview.result.readyCount} з {preview.result.representedCount}.</p>
    {preview.globalSourceDiagnostics?.length > 0 && <Notice>Залишилися питання до джерел інших категорій. Повна перевірка під час підготовки має їх вирішити.</Notice>}
    {preview.result.errors?.map((product) => <Notice tone="warning" key={product.productId}>{product.sku}: перевірте поля {product.fields.map((field) => field.field).join(', ')}. Приклад ще не готовий до передавання.</Notice>)}
    <ArtifactTables artifacts={preview.result.provisionalArtifacts || preview.result.artifacts} />
  </section>;
}

function FieldMappings({ field, questions, selections, setSelections, disabled }) {
  const entries = field.entries.filter((e) => e.kind === 'option');
  if (!entries.length) return null;
  const label = (entry) => {
    const match = entry.source.match(/\.([^.=]+)=value_id:(-?\d+)$/);
    const question = match && questions.find((q) => q.id === match[1]);
    return question?.options.find((o) => String(o.id) === match[2])?.label || entry.evaluated || entry.source;
  };
  const suggestions = uniqueOptionSuggestions(entries, field.options);
  const put = (entry, value) => setSelections((current) => ({ ...current, [decisionKey(entry)]: value }));
  return <section className="mc-field-mappings space-y-3" aria-label="Менеджер — Magento: значення">
    <h3 className="font-semibold">Наші значення → Magento</h3>
    <p>Навпроти кожного нашого значення виберіть відповідне значення магазину.</p>
    {suggestions.length > 0 && <button type="button" className="btn btn-outline" disabled={disabled} onClick={() => setSelections((current) => ({ ...current, ...Object.fromEntries(suggestions.map(({ entry, option }) => [decisionKey(entry), option.value])) }))}>Вибрати однозначні підказки ({suggestions.length})</button>}
    <div className="mc-table-scroll"><table><thead><tr><th>Менеджер</th><th>Magento</th></tr></thead><tbody>{entries.slice(0, 50).map((entry) => <tr key={entry.id}>
      <td>{label(entry)}</td><td><select className="input" aria-label={`Magento для ${label(entry)}`} disabled={disabled} value={selections[decisionKey(entry)] ?? entry.identity ?? ''} onChange={(e) => put(entry, e.target.value)}><option value="" disabled>Не вибрано</option>{field.options.filter((o) => !o.isEmpty).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></td>
    </tr>)}</tbody></table></div>
    {entries.length > 50 && <p>Показано перші 50 значень. Повний список доступний у перевірці підготовлених відповідностей.</p>}
  </section>;
}

function CategoryEditor({ initial, baseline, activePublication, onPublished, onScopeCommit }) {
  const auth = useAuth(); const [params, setParams] = useSearchParams();
  const [projection, setProjection] = useState(initial);
  const [base, setBase] = useState(baseline);
  const [definition, setDefinition] = useState(initial.template.definition);
  const [savedDefinition, setSavedDefinition] = useState(initial.template.definition);
  const [family, setFamily] = useState(null); const [revision, setRevision] = useState(initial.revision);
  const [registry, setRegistry] = useState(null); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState(false); const [discardPanel, setDiscardPanel] = useState(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [field, setField] = useState(params.get('field') || ''); const [loadedField, setLoadedField] = useState(null); const [fieldError, setFieldError] = useState('');
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all'); const [page, setPage] = useState(0);
  const [rowId, setRowId] = useState(params.get('language') === 'english' ? 'english' : 'base');
  const [routeKey, setRouteKey] = useState(projection.routeKey); const [tab, setTab] = useState(params.get('view') === 'text' ? 'text' : 'attributes');
  const [selections, setSelections] = useState({}); const [selectionDirty, setSelectionDirty] = useState(false);
  const [samples, setSamples] = useState([]); const [preview, setPreview] = useState(null); const [representatives, setRepresentatives] = useState([]);
  const [namesOpen, setNamesOpen] = useState(false); const [productChecks, setProductChecks] = useState(false);
  const [showService, setShowService] = useState(false); const [reviewReady, setReviewReady] = useState(false); const [checkRequested, setCheckRequested] = useState(false);
  const [narrow, setNarrow] = useState(() => globalThis.matchMedia?.('(max-width: 1100px)').matches || false);
  const [fieldOverlay, setFieldOverlay] = useState(narrow);
  const flight = useRef(false); const alive = useRef(true); const fieldSequence = useRef(0); const creationKey = useRef(null);
  const urlParams = useRef(params);
  const categoryCode = initial.category.code;
  const canManage = auth.permissions.includes('export_templates.manage');
  const canPublish = ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((p) => auth.permissions.includes(p));
  const dirty = rulesIdentity(definition) !== rulesIdentity(savedDefinition);
  const stale = (params.get('source') || base.revision.id) !== activePublication?.id;
  const groupIndex = definition.groups.findIndex((g) => g.route === categoryCode);
  const rowIndex = definition.groups[groupIndex].rows.findIndex((r) => r.id === rowId);
  const changed = changedFields(base.template.definition, definition, categoryCode);
  const currentField = projection.attributes.find((a) => a.code === field);
  const fieldKey = JSON.stringify([field, revision.id, revision.revision, routeKey, rowId]);
  const fieldData = loadedField?.key === fieldKey ? loadedField.data : null;
  const loadSource = useCallback((descriptor, signal) => templates.sourceDetails(descriptor, signal), []);
  const searchSamples = useCallback((query, signal) => api.get('/admin/export-templates/sample-products', { params: query, signal }).then((r) => ({ ...r, data: { ...r.data, products: r.data.products.filter((p) => p.category === categoryCode) } })), [categoryCode]);
  const navigation = useDirtyNavigation({ dirty: dirty || pending || selectionDirty || reviewPending, busy,
    discard: () => { setDefinition(savedDefinition); setPending(false); setSelections({}); setSelectionDirty(false); setField(''); },
    shouldBlock: ({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname || scopeParams.some((key) => new URLSearchParams(currentLocation.search).get(key) !== new URLSearchParams(nextLocation.search).get(key)) });
  useEffect(() => { urlParams.current = params; }, [params]);
  const replaceParams = (patch) => {
    const next = new URLSearchParams(urlParams.current);
    Object.entries(patch).forEach(([key, value]) => value == null ? next.delete(key) : next.set(key, value));
    urlParams.current = next;
    // Establish ownership before the router's synchronous URL notification.
    // Otherwise the shell can briefly unmount the editor and discard local input.
    navigation.commit(() => { flushSync(() => onScopeCommit(scopeIdentity(categoryCode, next))); setParams(next, { replace: true }); });
  };
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); const requests = fieldSequence;
    api.get('/admin/export-templates/sources', { signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) setRegistry(data); }).catch(() => { if (!controller.signal.aborted) setError('Реєстр характеристик недоступний. Редагування джерел заблоковано.'); });
    return () => { alive.current = false; controller.abort(); ++requests.current; };
  }, []);
  useEffect(() => {
    const media = globalThis.matchMedia?.('(max-width: 1100px)'); if (!media) return undefined;
    const update = () => setNarrow(media.matches); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!dirty && !pending && !selectionDirty && !reviewPending) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, pending, selectionDirty, reviewPending]);
  useEffect(() => {
    const id = params.get('ruleDraft'); if (!id) return undefined;
    const controller = new AbortController();
    templates.get(id).then(({ data }) => {
      if (controller.signal.aborted) return;
      if (!data.draft.definition.groups?.some((g) => g.route === categoryCode)) { setError('Збережена чернетка не містить цієї категорії.'); return; }
      setFamily(data); setDefinition(data.draft.definition); setSavedDefinition(data.draft.definition);
    }).catch((cause) => { if (!controller.signal.aborted) setError(fail(cause)); });
    return () => controller.abort();
    // The URL is updated after save; restoration runs only when entering this editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!field || !currentField?.configured) return undefined;
    const controller = new AbortController(); const ticket = ++fieldSequence.current;
    api.get(`${root}/categories/${categoryCode}/fields/${encodeURIComponent(field)}`, { signal: controller.signal, params: { bindingRevisionId: revision.id, ...(routeKey ? { routeKey } : {}), rowId } }).then(({ data }) => {
      if (!controller.signal.aborted && ticket === fieldSequence.current) { setLoadedField({ key: fieldKey, data }); setFieldError(''); }
    }).catch((cause) => { if (!controller.signal.aborted && ticket === fieldSequence.current) setFieldError(fail(cause)); });
    return () => controller.abort();
  }, [categoryCode, currentField?.configured, field, fieldKey, revision.id, revision.revision, routeKey, rowId]);

  async function run(operation) {
    if (flight.current || pending || reviewPending || stale) return;
    flight.current = true; setBusy(true); setError(''); setMessage('');
    try { return await operation(); } catch (cause) { if (alive.current) setError(fail(cause)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  }
  async function save() {
    let next = family;
    if (!next) {
      creationKey.current ||= `magento-edit-${crypto.randomUUID()}`;
      try {
        next = (await templates.create({ key: creationKey.current, displayName: `Magento · ${initial.category.name}`, definition })).data;
      } catch (cause) {
        // Recover an ambiguous committed create by its private key, without touching another draft.
        const families = (await templates.list()).data;
        const recovered = families.find((item) => item.template_key === creationKey.current);
        if (!recovered) throw cause;
        next = (await templates.get(recovered.id)).data;
        if (rulesIdentity(next.draft.definition) !== rulesIdentity(definition)) throw cause;
      }
      if (alive.current) { setFamily(next); replaceParams({ ruleDraft: next.id, source: base.revision.id }); }
    } else if (dirty) {
      next = { ...next, draft: (await templates.save(next.id, { expectedRevision: next.draft.revision, definition })).data };
      if (alive.current) setFamily(next);
    }
    if (alive.current) { setSavedDefinition(next.draft.definition); setPreview(null); }
    return next;
  }
  async function prepare() {
    let versionId = base.revision.templateVersionId;
    if (changed.length || family) {
      const next = await save();
      const body = { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash };
      await templates.validate(next.id, body);
      const published = (await templates.publish(next.id, body)).data;
      versionId = published.id;
    }
    const request = { sourceId: base.revision.id, expectedSourceRevision: base.revision.revision, templateVersionId: versionId };
    const preparation = (await api.post(`${root}/successor/prepare`, request)).data;
    let draft = (await api.post(`${root}/successor/apply`, { ...request, previewToken: preparation.previewToken })).data;
    if (!alive.current) return;
    setRevision(draft); setRepresentatives([]); setReviewReady(false); setCheckRequested(true);
    replaceParams({ binding: draft.id, source: base.revision.id });
    // Store explicitly selected IDs in the isolated draft. Approval remains a separate action.
    if (selectionDirty) {
      const { data } = await api.get(`${root}/bindings/${draft.id}`);
      try {
        for (const entry of data.entries.filter((e) => e.group === categoryCode && e.kind === 'option')) {
          const identity = selections[decisionKey(entry)];
          if (identity !== undefined && identity !== String(entry.identity ?? '')) {
            draft = (await api.post(`${root}/bindings/${draft.id}/select`, { expectedRevision: draft.revision, binding: entry.id, identity })).data;
          }
        }
      } finally { if (alive.current) setRevision(draft); }
    }
    const result = (await api.get(`${root}/categories/${categoryCode}`, { params: { bindingRevisionId: draft.id, ...(routeKey ? { routeKey } : {}), rowId } })).data;
    if (alive.current) { setProjection(result); setSelections({}); setSelectionDirty(false); setMessage('Підготовку збережено. Перевірте відповідності й вплив перед застосуванням.'); }
  }
  const chooseField = (next) => {
    if (reviewPending) { setError('Завершіть або відкиньте незбережені рішення в огляді підготовки перед редагуванням поля.'); return; }
    const action = () => { setPending(false); setField(next); setFieldOverlay(narrow); setFieldError(''); replaceParams({ field: next || null }); };
    if (pending) setDiscardPanel(() => action); else action();
  };
  const scope = async (nextRoute, nextRow) => {
    await run(async () => {
      const { data } = await api.get(`${root}/categories/${categoryCode}`, { params: { bindingRevisionId: revision.id, ...(nextRoute ? { routeKey: nextRoute } : {}), rowId: nextRow } });
      if (alive.current) { setProjection(data); setRouteKey(nextRoute); setRowId(nextRow); setPage(0); setField(''); replaceParams({ route: nextRoute, language: nextRow, field: null }); }
    });
  };
  const setLocalSelections = (transform) => { setSelections(transform); setSelectionDirty(true); };
  const fieldConfigured = currentField && Object.hasOwn(definition.groups[groupIndex].rows[rowIndex].cells, currentField.target);
  const tabFields = projection.attributes.filter((a) => tab === 'text' ? a.text : !a.text);
  const serviceCount = tabFields.filter((a) => !a.editable).length;
  const displayed = tabFields.filter((a) => (showService || a.editable) && (filter === 'all' || filter === 'unmapped' && !a.configured || filter === 'review' && a.state === 'review')
    && `${a.label} ${a.code} ${a.sources.map((s) => s.label).join(' ')}`.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(displayed.length / 30) - 1));
  const prepared = revision.state === 'draft' && !dirty && !pending && rulesIdentity(definition) === rulesIdentity(projection.template.definition);
  const hasChanges = changed.length > 0 || selectionDirty;
  const fieldRule = (attribute) => summary(definition, at(definition, ['groups', groupIndex, 'rows', rowIndex, 'cells', attribute.target]));
  return <div className={`mc-category-content${field ? ' has-editor' : ''}`}>
    <section className="mc-fields space-y-4">
      <header><h2>{initial.category.name}</h2><p className="mc-help">{tab === 'text' ? 'Виберіть назву або опис і відредагуйте текст.' : 'Натисніть на характеристику, щоб вибрати, що передавати з нашого менеджера.'}</p></header>
      {stale && <Notice tone="warning">Чинна інтеграція змінилася. Ваше введення залишено у формі. Підготовка потребує порівняння з новою версією; автоматичного перезапису немає. <Link className="underline" to={`/admin/magento?category=${categoryCode}`}>Відкрити чинну інтеграцію</Link></Notice>}
      {error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}
      {projection.routes.length > 1 && <label className="mc-label">Вид товару / набір Magento<select className="input" value={routeKey || ''} disabled={busy || pending} onChange={(e) => scope(e.target.value, rowId)}>{projection.routes.map((route) => <option key={route.routeKey} value={route.routeKey}>{routeLabel(route, projection.questions)}</option>)}</select></label>}
      {projection.routes.length === 1 && projection.routes[0].setName !== initial.category.name && <p className="mc-help">Поля для товарів: <strong>{projection.routes[0].setName}</strong></p>}
      {!projection.routes.length && <Notice>Категорію ще не підключено до набору Magento. <Link className="underline" to={`/admin/magento/prepare?category=${categoryCode}&intent=connect`}>Налаштувати підключення</Link></Notice>}
      <nav className="mc-tabs" aria-label="Поля категорії">{[['attributes', 'Характеристики'], ['text', 'Назва й описи']].map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => { setTab(value); setPage(0); setShowService(false); replaceParams({ view: value }); }}>{label}</button>)}<label>Мова<select aria-label="Мова полів" className="input" value={rowId} disabled={busy || pending} onChange={(e) => scope(routeKey, e.target.value)}><option value="base">UA</option><option value="english">EN</option></select></label></nav>
      <div className="mc-status-counts" aria-label="Стан полів"><span>Підключено: <strong>{tabFields.filter((a) => a.editable && a.state === 'connected').length}</strong></span><span>Не підключено: <strong>{tabFields.filter((a) => a.editable && a.state === 'unmapped').length}</strong></span><span>Перевірити: <strong>{tabFields.filter((a) => a.editable && a.state === 'review').length}</strong></span></div>
      <div className="mc-actions"><label className="mc-label">Пошук поля<input className="input" type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></label><label className="mc-label">Показати<select className="input" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}><option value="all">Усі</option><option value="unmapped">Без прив’язки</option><option value="review">Потребують перевірки</option></select></label></div>
      <div className="mc-table-scroll"><table className="mc-field-table"><caption className="sr-only">Поля Magento та джерела менеджера</caption><thead><tr><th>У Magento</th><th>{tab === 'text' ? 'Наш текст' : 'З нашого менеджера'}</th><th>Стан</th></tr></thead><tbody>{displayed.slice(currentPage * 30, (currentPage + 1) * 30).map((attribute) => <tr key={attribute.code} className={field === attribute.code ? 'is-selected' : ''}>
        <th scope="row"><button type="button" className="mc-field-link" onClick={() => chooseField(attribute.code)}>{attribute.label}</button></th>
        <td>{tab === 'text' && attribute.configured ? <span className="mc-text-summary" title={fieldRule(attribute)}>{fieldRule(attribute)}</span> : attribute.sources.length ? [...new Set(attribute.sources.map((s) => s.label))].join(', ') : attribute.configured ? 'Налаштоване значення' : <span className="mc-missing">Оберіть характеристику</span>}</td>
        <td><span className={`mc-state mc-state-${attribute.state}`}>{changed.some((change) => change.field === attribute.target && change.rowId === rowId) ? 'Є зміна' : !attribute.editable ? 'Лише перегляд' : attribute.unresolved ? `Перевірити відповідності: ${attribute.unresolved}` : messages[attribute.state]}</span></td>
      </tr>)}</tbody></table></div>
      {!displayed.length && <EmptyState>Полів за цим фільтром немає.</EmptyState>}
      {serviceCount > 0 && <button type="button" className="mc-help mc-field-link" aria-expanded={showService} onClick={() => setShowService(!showService)}>{showService ? 'Сховати службові поля' : `Службові поля (${serviceCount})`}</button>}
      {displayed.length > 30 && <nav className="mc-actions" aria-label="Сторінки полів"><button className="btn btn-outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Назад</button><span>{currentPage + 1} / {Math.ceil(displayed.length / 30)}</span><button className="btn btn-outline" disabled={(currentPage + 1) * 30 >= displayed.length} onClick={() => setPage(currentPage + 1)}>Далі</button></nav>}
      {tab === 'attributes' && <section className="mc-unbound space-y-2" aria-label="Наші характеристики, які ще не передаються"><h3 className="font-semibold">Ще не передаємо з менеджера ({projection.unboundCount})</h3>
        <div className="mc-question-list">{projection.questions.filter((q) => !q.uses.length).map((q) => <span key={q.id}>{q.label}</span>)}</div>
        {projection.unboundCount > 0 && <p className="mc-help">Щоб підключити, виберіть відповідне поле Magento у таблиці вище.</p>}
        {!projection.unboundCount && <p>Усі характеристики використовуються у правилах передавання.</p>}
        <MagentoDetails summary="Характеристики, використані в тексті">{() => projection.questions.filter((q) => q.uses.some((use) => projection.attributes.some((a) => a.target === use.target && a.text))).map((q) => <p key={q.id}>{q.label} · {q.uses.map((use) => use.target).join(', ')}</p>)}</MagentoDetails>
      </section>}
      {canManage && (hasChanges || prepared || family) && <section className="mc-change-bar space-y-3" aria-label="Підготовлені зміни">
        <h3 className="font-semibold">Ваші зміни{changed.length > 0 ? `: ${changed.length}` : ''}{selectionDirty ? ' · вибрані відповідності' : ''}</h3>
        {changed.map((change) => <p key={`${change.field}:${change.rowId}`}>{projection.attributes.find((a) => a.target === change.field)?.label || change.field} · {change.rowId === 'english' ? 'EN' : 'UA'}</p>)}
        {(!prepared || selectionDirty) && <div className="mc-actions">{canPublish ? <button type="button" className="btn btn-primary" disabled={busy || pending || stale || reviewPending} onClick={() => run(prepare)}>Перевірити зміни</button> : <button type="button" className="btn btn-primary" disabled={busy || pending || stale} onClick={() => run(async () => { await save(); setMessage('Чернетку збережено. Чинна інтеграція ще не змінена.'); })}>Зберегти чернетку</button>}</div>}
        <p className="mc-help">{prepared ? 'Перевірте відповідності нижче й застосуйте зміни.' : 'Перевірка збереже вашу роботу й покаже, що зміниться для товарів.'}</p>
        {canPublish && <MagentoDetails summary="Зберегти й продовжити пізніше">{() => <button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(async () => { await save(); setMessage('Чернетку збережено. Чинна інтеграція ще не змінена.'); })}>Зберегти чернетку</button>}</MagentoDetails>}
        {!canPublish && <p className="text-sm">Збережену чернетку може продовжити користувач із правами публікації та перегляду експорту.</p>}
        {definition.outputContract !== COLUMN_CONTRACT && <MagentoDetails summary="Підключення додаткових полів">{() => <><p>Для додавання поля потрібне явне оновлення формату чернетки. Поточна публікація зберігається.</p><button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(async () => { const next = await save(); const draft = (await templates.upgrade(next.id, { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash })).data; setFamily({ ...next, draft }); setDefinition(draft.definition); setSavedDefinition(draft.definition); setMessage('Формат чернетки оновлено. Потрібно повторно перевірити відповідності перед застосуванням.'); })}>Оновити формат чернетки</button></>}</MagentoDetails>}
      </section>}
      {tab === 'text' && canManage && auth.permissions.includes('exports.view') && <MagentoDetails summary="Приклад тексту на товарі">{() => <section className="space-y-3" aria-label="Приклад текстових шаблонів"><SampleProducts search={searchSamples} selected={samples} onChange={(next) => { setSamples(next.slice(-1)); setPreview(null); }} /><button type="button" className="btn btn-outline" disabled={busy || pending || !samples.length || stale} onClick={() => run(async () => { const next = await save(); const { data } = await templates.preview(next.id, { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash, productIds: samples.map((p) => p.id) }); setPreview(data); })}>Перевірити приклад</button>{preview && <SampleResult preview={preview} />}</section>}</MagentoDetails>}
      {prepared && <>
        <MagentoWorkspaceReview revision={revision} categoryCode={categoryCode} questions={projection.questions} selections={selections} disabled={!canManage || busy || stale} onReadyChange={setReviewReady} onPendingChange={setReviewPending} onChanged={(next) => { setReviewReady(false); setRevision(next); setPreview(null); }} />
        {canPublish && <MagentoDetails summary="Приклад на товарі">{() => <><button type="button" className="btn btn-outline" onClick={() => setProductChecks(!productChecks)}>{productChecks ? 'Сховати перевірку товарів' : 'Вибрати товар для перевірки'}</button>{productChecks && <MagentoProductChecks key={`${revision.id}:${revision.revision}`} revision={revision} categoryCode={categoryCode} onRepresentative={(example) => setRepresentatives((current) => [...current.filter((e) => e.routeKey !== example.routeKey), { ...example, revision: revision.revision }])} />}</>}</MagentoDetails>}
        <MagentoPublicationActions compact autoPreview={checkRequested && reviewReady} disabled={busy || stale || selectionDirty || reviewPending} revision={revision} currentPublishedId={activePublication?.id} representatives={representatives.filter((e) => e.revision === revision.revision)} onPublished={(next) => {
          setRevision(next); setBase({ ...projection, revision: next, template: { ...projection.template, definition } });
          setFamily(null); creationKey.current = null; setSavedDefinition(definition); setSelections({}); setSelectionDirty(false);
          replaceParams({ binding: next.id, source: next.id, ruleDraft: null });
          setMessage('Зміни застосовано в Amber. Результат доставки відстежується окремо.'); onPublished(next);
          api.get(`${root}/categories/${categoryCode}`, { params: { bindingRevisionId: next.id, ...(routeKey ? { routeKey } : {}), rowId } }).then(({ data }) => { if (alive.current) setProjection(data); }).catch((cause) => { if (alive.current) setError(fail(cause)); });
        }} />
      </>}
      {revision.state === 'published' && isActualAdministrator(auth) && canPublish && auth.permissions.includes('exports.create') && <section className="space-y-3"><button type="button" className="btn btn-outline" onClick={() => setNamesOpen(!namesOpen)}>Застосувати назви до чинних товарів</button>{namesOpen && <MagentoControlledActions revision={revision} currentPublishedId={activePublication?.id} categoryCode={categoryCode} kind="name_rule" />}</section>}
      {busy && <LoadingState compact label="Зберігаємо й перевіряємо підготовку…" />}
      <MagentoDetails summary="Дані Magento та додаткові налаштування">{() => <div className="space-y-3"><p>Структура Magento: {date(projection.observedAt)}{projection.liveObservation && ' · щойно прочитано'}</p><div className="mc-actions"><button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(async () => { const { data } = await api.post(`${root}/categories/${categoryCode}/observation`, { bindingRevisionId: revision.id, ...(routeKey ? { routeKey } : {}), rowId }); setProjection(data); setMessage('Дані Magento оновлено. Перегляньте нові поля та зміни, що потребують перевірки.'); })}>{busy ? 'Читаємо Magento…' : 'Оновити структуру Magento'}</button><Link className="text-sm underline" to={`/admin/magento/categories/${categoryCode}?tab=placement`}>Розміщення в магазині</Link>{canManage && canPublish && !hasChanges && !prepared && <button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(prepare)}>Змінити поведінку передавання полів</button>}</div></div>}</MagentoDetails>
    </section>
    {field && <FieldSurface overlay={fieldOverlay} busy={busy} suspended={Boolean(discardPanel)} onClose={() => chooseField('')}>
      {fieldError && <Notice tone="error">{fieldError}</Notice>}{currentField?.configured && !fieldData && !fieldError && <LoadingState compact label="Читаємо поле…" />}
      {currentField && <>
        {currentField.restriction && <Notice>{currentField.restriction}</Notice>}
        {fieldData && <FieldMappings field={fieldData} questions={projection.questions} selections={selections} setSelections={setLocalSelections} disabled={!canManage || busy || stale || !currentField.editable} />}
        {!fieldConfigured && currentField.editable && canManage && <section className="space-y-3"><h3>{currentField.label}</h3><p>Оберіть джерело й поведінку поля. Інша мова залишиться порожньою до окремого налаштування.</p><button type="button" className="btn btn-primary" disabled={busy || stale || definition.outputContract !== COLUMN_CONTRACT} onClick={() => { setDefinition(columnChange(definition, groupIndex, 'add', null, currentField.code)); setPreview(null); }}>Підключити поле</button>{definition.outputContract !== COLUMN_CONTRACT && <p>Спочатку оновіть формат чернетки в підготовлених змінах.</p>}</section>}
        {fieldConfigured && registry && <ColumnInspector key={`${field}:${rowId}:${routeKey}`} integration embedded localOnly simple textOnly={currentField.text} title={currentField.label} definition={definition} groupIndex={groupIndex} rowIndex={rowIndex} column={currentField.target} registry={registry} loadSource={loadSource}
          suspended={busy || Boolean(discardPanel)} readOnly={!canManage || stale || !currentField.editable}
          onPendingChange={setPending} onRequestClose={() => chooseField('')} onCancel={() => chooseField('')}
          onApply={(next, base) => { if (base !== definition) return false; assertCategoryScope(definition, next, categoryCode, rowId); setDefinition(next); setPending(false); setPreview(null); setField(''); replaceParams({ field: null }); return true; }} />}
        {currentField.policy && <p className="mc-help">{deliveryPolicies[currentField.policy]}</p>}
        {!fieldConfigured && <MagentoDetails>{() => <p>Код: {currentField.code} · {currentField.inputType || 'службове поле'}</p>}</MagentoDetails>}
        {!fieldConfigured && <button type="button" className="btn btn-outline" onClick={() => chooseField('')}>Закрити поле</button>}
      </>}
    </FieldSurface>}
    {navigation.prompt}
    {discardPanel && <WorkspaceDialog title="Незбережене поле" onClose={() => setDiscardPanel(null)}><h2>Є незастосоване введення поля</h2><p>Застосуйте його до чернетки або явно відкиньте перед переходом.</p><button type="button" className="btn btn-outline" onClick={() => setDiscardPanel(null)}>Залишитися</button><button type="button" className="btn btn-outline" onClick={() => { discardPanel(); setDiscardPanel(null); }}>Відкинути введення поля</button></WorkspaceDialog>}
  </div>;
}

export default function MagentoCategoryWorkspace({ categories, activePublication, onPublished }) {
  const path = useParams(); const [params] = useSearchParams(); const [search, setSearch] = useState('');
  const location = useLocation(); const navigationType = useNavigationType();
  const categoryCode = path.categoryCode || params.get('category');
  const scopeKey = scopeIdentity(categoryCode, params);
  const [loaded, setLoaded] = useState(null); const [error, setError] = useState('');
  const [ownedScope, setOwnedScope] = useState(null);
  const owned = ownedScope?.editorKey === loaded?.editorKey && (location.key === ownedScope?.priorLocationKey || navigationType === 'REPLACE' && ownedScope?.scopes.includes(scopeKey));
  useEffect(() => {
    if (!categoryCode || !ownedScope && loaded?.scopeKey === scopeKey) return undefined;
    if (owned) {
      // Save + preparation can commit several URLs before React Router renders.
      // Browser/back/link navigation has a different key and is read separately.
      return undefined;
    }
    const controller = new AbortController();
    const query = { ...(params.get('binding') || activePublication?.id ? { bindingRevisionId: params.get('binding') || activePublication.id } : {}), ...(params.get('route') ? { routeKey: params.get('route') } : {}), rowId: params.get('language') === 'english' ? 'english' : 'base' };
    const baseQuery = params.get('source') || activePublication?.id ? { bindingRevisionId: params.get('source') || activePublication.id } : {};
    Promise.all([api.get(`${root}/categories/${categoryCode}`, { signal: controller.signal, params: query }),
      api.get(`${root}/categories/${categoryCode}`, { signal: controller.signal, params: baseQuery })]).then(([selected, baseline]) => {
      if (!controller.signal.aborted) { setOwnedScope(null); setLoaded({ categoryCode, scopeKey, editorKey: scopeKey, data: selected.data, baseline: baseline.data }); setError(''); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(fail(cause)); });
    return () => controller.abort();
    // Editing/restoration owns its exact draft; refreshing the shell cannot replace local input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, location.key]);
  const data = !ownedScope && loaded?.scopeKey === scopeKey || owned ? loaded?.data : null;
  const filtered = categories.filter((c) => `${c.name} ${c.code}`.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  return <div className="mc-workspace">
    <aside className="mc-categories" aria-label="Категорії менеджера"><h2>Категорії</h2><label className="mc-label">Пошук категорії<input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label><nav>{filtered.map((c) => <Link key={c.code} aria-current={c.code === categoryCode ? 'page' : undefined} to={`/admin/magento?category=${encodeURIComponent(c.code)}`}><strong>{c.name}</strong><small>{c.unboundCount == null ? 'Відповідності — у категорії' : `Ще не передаємо: ${c.unboundCount}`}</small>{c.operational.count > 0 && <small>Проблеми товарів: {c.operational.count}</small>}</Link>)}</nav>{!filtered.length && <p>Категорій за цим пошуком немає.</p>}</aside>
    {!categoryCode ? <EmptyState title="Оберіть категорію менеджера">Побачите поля Magento, наші характеристики та текстові шаблони.</EmptyState> : error ? <Notice tone="error">{error}</Notice> : !data ? <LoadingState label="Читаємо категорію…" /> : !data.template || data.groupIndex < 0 ? <EmptyState title={data.category.name}>Категорію ще не включено до правил Magento. <Link className="underline" to={`/admin/magento/prepare?category=${categoryCode}&intent=connect`}>Налаштувати підключення</Link></EmptyState> : <CategoryEditor key={loaded.editorKey} initial={data} baseline={loaded.baseline.template ? loaded.baseline : data} activePublication={activePublication} onPublished={onPublished} onScopeCommit={(nextScope) => setOwnedScope((current) => ({ key: nextScope, priorLocationKey: location.key, scopes: [...new Set([scopeKey, ...(current?.priorLocationKey === location.key ? current.scopes : []), nextScope])], editorKey: loaded.editorKey }))} />}
  </div>;
}
