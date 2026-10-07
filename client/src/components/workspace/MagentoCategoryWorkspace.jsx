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
import { assertCategoryScope, changedFields, decisionKey, deliveryPolicies, deliveryPolicyEffect, localValueLabel, matchesRepairValue, reviewScopeSummary, routeLabel, rulesIdentity, uniqueOptionSuggestions } from '../../lib/magento-category-workspace.js';
import { repairContext } from '../../lib/magento-repair-context.js';
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
import RetiredCatalogNotice from './RetiredCatalogNotice.jsx';
import { CatalogDeletionEntry } from '../admin/CatalogDeletionEntry.jsx';
import '../export-templates/export-template-editor.css';
import './magento-category-workspace.css';

const root = '/admin/magento-integration';
const date = (value) => value ? new Date(value).toLocaleString('uk-UA') : 'Спостереження відсутнє';
const messages = { unmapped: 'Не передається', connected: 'Підключено', review: 'Потребує перевірки', empty: 'Не заповнюємо', excluded: 'Передавання виключено' };
const fail = (cause) => cause.response?.data?.error || cause.message || 'Дію не завершено. Введені зміни збережено у формі.';
const scopeParams = ['category', 'binding', 'source', 'ruleDraft', 'route', 'language', 'field', 'view', 'reviewField', 'tab', 'path', 'productId', 'question', 'value', 'returnTo'];
const scopeIdentity = (categoryCode, params) => JSON.stringify([categoryCode, ...scopeParams.map((key) => params.get(key))]);

function FieldSurface({ children, busy, suspended, onClose }) {
  return <WorkspaceDialog title="Поле Magento" className="mc-field-dialog" busy={busy} suspended={suspended} onClose={onClose}><div className="mc-editor">{children}</div></WorkspaceDialog>;
}

function SampleResult({ preview }) {
  return <section aria-label="Результат прикладу" className="space-y-2">
    <p>Сервер обчислив приклад: готові {preview.result.readyCount} з {preview.result.representedCount}.</p>
    {preview.globalSourceDiagnostics?.length > 0 && <Notice>Залишилися питання до джерел інших категорій. Повна перевірка під час підготовки має їх вирішити.</Notice>}
    {preview.result.errors?.map((product) => <Notice tone="warning" key={product.productId}>{product.sku}: перевірте поля {product.fields.map((field) => field.field).join(', ')}. Приклад ще не готовий до передавання.</Notice>)}
    <ArtifactTables artifacts={preview.result.provisionalArtifacts || preview.result.artifacts} />
  </section>;
}

function FieldMappings({ active = true, rulePending = false, field, questions, selections, setSelections, disabled, context, deletionContext }) {
  const entries = field.entries.filter((e) => e.kind === 'option');
  const ordered = [...entries.filter((entry) => matchesRepairValue(entry, context)), ...entries.filter((entry) => !matchesRepairValue(entry, context))];
  const focusRow = useRef(null);
  useEffect(() => {
    // Run after the generic column inspector's opening focus, then retain the
    // exact repair row. Navigation still never chooses or approves a value.
    if (!active) return undefined;
    const timer = setTimeout(() => { focusRow.current?.scrollIntoView?.({ block: 'nearest' }); focusRow.current?.focus({ preventScroll: true }); }, 0);
    return () => clearTimeout(timer);
  }, [active, field.entries, context?.question, context?.value]);
  if (!entries.length) return null;
  const label = (entry) => {
    const match = entry.source.match(/\.([^.=]+)=value_id:(-?\d+)$/);
    return match ? localValueLabel(questions, match[1], match[2], entry.evaluated) : entry.evaluated || 'Значення правила';
  };
  const suggestions = rulePending ? [] : uniqueOptionSuggestions(entries, field.options);
  const put = (entry, value) => setSelections((current) => ({ ...current, [decisionKey(entry)]: value }));
  return <section className="mc-field-mappings space-y-3" aria-label="Менеджер — Magento: значення">
    <h3 className="font-semibold">Варіанти магазину для наших значень</h3>
    <p>Виберіть варіанти Magento. Текст і умови налаштовуються у вкладці «Формування значення». «Готово» додасть обидві частини до змін.</p>
    {rulePending && <p className="mc-help">Правило змінено: перегляньте варіанти Magento вручну. Після підготовки підтвердьте їх у перевірці відповідностей.</p>}
    {suggestions.length > 0 && <button type="button" className="btn btn-outline" disabled={disabled} onClick={() => setSelections((current) => ({ ...current, ...Object.fromEntries(suggestions.map(({ entry, option }) => [decisionKey(entry), option.value])) }))}>Вибрати однозначні підказки ({suggestions.length})</button>}
    <div className="mc-table-scroll"><table><thead><tr><th>Менеджер</th><th>Magento</th></tr></thead><tbody>{ordered.slice(0, 50).map((entry) => <tr key={entry.id} ref={matchesRepairValue(entry, context) ? focusRow : undefined} tabIndex={matchesRepairValue(entry, context) ? -1 : undefined} className={matchesRepairValue(entry, context) ? 'is-repair-target' : undefined}>
      <td>{label(entry)}{matchesRepairValue(entry, context) && <small>Значення з проблеми цього товару</small>}</td><td><select className="input" aria-label={`Magento для ${label(entry)}`} disabled={disabled} value={selections[decisionKey(entry)] ?? entry.identity ?? ''} onChange={(e) => put(entry, e.target.value)}><option value="" disabled>Не вибрано</option>{field.options.filter((o) => !o.isEmpty).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        {deletionContext?.isAdministrator && <CatalogDeletionEntry {...deletionContext} field={field} questions={questions} optionEntry={entry}/>}
      </td>
    </tr>)}</tbody></table></div>
    {entries.length > 50 && <p>Показано перші 50 значень. Повний список доступний у перевірці підготовлених відповідностей.</p>}
  </section>;
}

function CategoryEditor({ initial, baseline, categories, activePublication, onPublished, onScopeCommit }) {
  const auth = useAuth(); const [params, setParams] = useSearchParams();
  const entryContext = repairContext(params);
  const repairTargets = [...new Set((initial.questions.find((question) => question.id === entryContext.question)?.uses || []).filter((use) => use.rowId === (params.get('language') === 'english' ? 'english' : 'base')).map((use) => use.target))];
  const requestedField = params.get('field') || (repairTargets.length === 1 ? initial.attributes.find((attribute) => attribute.target === repairTargets[0])?.code : '') || '';
  const [projection, setProjection] = useState(initial);
  const [base, setBase] = useState(baseline);
  const [definition, setDefinition] = useState(initial.template.definition);
  const [savedDefinition, setSavedDefinition] = useState(initial.template.definition);
  const [family, setFamily] = useState(null); const [revision, setRevision] = useState(initial.revision);
  const [registry, setRegistry] = useState(null); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [pending, setPending] = useState(false); const [discardPanel, setDiscardPanel] = useState(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [field, setField] = useState(requestedField); const [loadedField, setLoadedField] = useState(null); const [fieldError, setFieldError] = useState('');
  const [search, setSearch] = useState(''); const [filter, setFilter] = useState('all'); const [page, setPage] = useState(0);
  const [rowId, setRowId] = useState(params.get('language') === 'english' ? 'english' : 'base');
  const [routeKey, setRouteKey] = useState(projection.routeKey); const [tab, setTab] = useState(params.get('view') === 'placement' || params.get('tab') === 'placement' || params.get('path') || params.get('field') === 'categories' ? 'placement' : params.get('view') === 'text' || projection.attributes.some((a) => a.code === params.get('field') && a.text) ? 'text' : 'attributes');
  const [reviewTarget, setReviewTarget] = useState(params.get('reviewField') || '');
  const [selections, setSelections] = useState({}); const [selectionDirty, setSelectionDirty] = useState(false);
  const [fieldSelections, setFieldSelections] = useState(null);
  const mappingPending = fieldSelections !== null && rulesIdentity(fieldSelections) !== rulesIdentity(selections);
  const [samples, setSamples] = useState([]); const [preview, setPreview] = useState(null); const [representatives, setRepresentatives] = useState([]);
  const [namesOpen, setNamesOpen] = useState(false); const [productChecks, setProductChecks] = useState(false);
  const [showService, setShowService] = useState(false); const [reviewReady, setReviewReady] = useState(false); const [checkRequested, setCheckRequested] = useState(false);
  const [reviewProgress, setReviewProgress] = useState('');
  const [applied, setApplied] = useState(false);
  const [activeDeletionReview, setActiveDeletionReview] = useState(null);
  const [reviewScope, setReviewScope] = useState(initial.reviewScope || null);
  const flight = useRef(false); const alive = useRef(true); const fieldSequence = useRef(0); const creationKey = useRef(null);
  const reviewPanel = useRef(null); const revealReview = useRef(false);
  const projectionRead = useRef(0);
  const urlParams = useRef(params);
  const categoryCode = initial.category.code;
  const context = repairContext(params);
  const canManage = auth.permissions.includes('export_templates.manage');
  const canPublish = ['export_templates.manage', 'export_templates.publish', 'exports.view'].every((p) => auth.permissions.includes(p));
  const dirty = rulesIdentity(definition) !== rulesIdentity(savedDefinition);
  const retired = Boolean(revision.catalogAvailability?.publicationBlocked);
  const stale = (params.get('source') || base.revision.id) !== activePublication?.id || retired;
  const groupIndex = definition.groups.findIndex((g) => g.route === categoryCode);
  const rowIndex = definition.groups[groupIndex].rows.findIndex((r) => r.id === rowId);
  const changed = changedFields(base.template.definition, definition, categoryCode);
  const currentField = projection.attributes.find((a) => a.code === field);
  const fieldKey = JSON.stringify([field, revision.id, revision.revision, routeKey, rowId]);
  const fieldData = loadedField?.key === fieldKey ? loadedField.data : null;
  const loadSource = useCallback((descriptor, signal) => templates.sourceDetails(descriptor, signal), []);
  const searchSamples = useCallback((query, signal) => api.get('/admin/export-templates/sample-products', { params: query, signal }).then((r) => ({ ...r, data: { ...r.data, products: r.data.products.filter((p) => p.category === categoryCode) } })), [categoryCode]);
  const navigation = useDirtyNavigation({ dirty: dirty || pending || selectionDirty || reviewPending, busy:busy || Boolean(activeDeletionReview),
    discard: () => { setDefinition(savedDefinition); setPending(false); setSelections({}); setSelectionDirty(false); setFieldSelections(null); setField(''); },
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
    const request = { sourceId: base.revision.id, expectedSourceRevision: base.revision.revision, templateVersionId: versionId,
      ...(context.productId ? { productIds: [Number(context.productId)] } : {}) };
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
    const action = () => { setPending(false); setField(next); setFieldSelections(null); setFieldError(''); replaceParams({ field: next || null }); };
    if (pending) setDiscardPanel(() => action); else action();
  };
  const checkBinding = (target) => run(async () => {
    revealReview.current = true;
    setApplied(false);
    setCheckRequested(true);
    setReviewTarget(target); setField(''); replaceParams({ field: null, reviewField: target });
    if (revision.state !== 'draft') await prepare();
  });
  async function reviewChanged(next) {
    setReviewReady(false); setRevision(next); setPreview(null);
    const ticket = ++projectionRead.current; const scope = urlParams.current.toString();
    try {
      const { data } = await api.get(`${root}/categories/${categoryCode}`, { params: { bindingRevisionId: next.id, ...(routeKey ? { routeKey } : {}), rowId } });
      if (alive.current && ticket === projectionRead.current && scope === urlParams.current.toString()) setProjection(data);
    } catch (cause) { if (alive.current && ticket === projectionRead.current && scope === urlParams.current.toString()) setError(fail(cause)); }
  }
  const scope = async (nextRoute, nextRow) => {
    await run(async () => {
      const { data } = await api.get(`${root}/categories/${categoryCode}`, { params: { bindingRevisionId: revision.id, ...(nextRoute ? { routeKey: nextRoute } : {}), rowId: nextRow } });
      if (alive.current) { setProjection(data); setRouteKey(nextRoute); setRowId(nextRow); setPage(0); setField(''); replaceParams({ route: nextRoute, language: nextRow, field: null }); }
    });
  };
  const setLocalSelections = (transform) => setFieldSelections((current) => {
    const next = transform(current ?? selections);
    // Returning to an existing identity is a no-op when there was no earlier
    // package-level choice. Keep choices already applied to this local package.
    for (const entry of fieldData?.entries || []) {
      const key = decisionKey(entry);
      if (!Object.hasOwn(selections, key) && next[key] === String(entry.identity ?? '')) delete next[key];
    }
    return next;
  });
  const fieldConfigured = currentField && Object.hasOwn(definition.groups[groupIndex].rows[rowIndex].cells, currentField.target);
  const tabFields = projection.attributes.filter((a) => tab === 'text' ? a.text && a.code !== 'categories' : !a.text && a.code !== 'categories');
  const serviceCount = tabFields.filter((a) => a.service || !a.editable).length;
  const displayed = tabFields.filter((a) => (showService || !a.service && a.editable) && (filter === 'all' || filter === 'unmapped' && !a.configured || filter === 'review' && a.state === 'review')
    && `${a.label} ${a.code} ${a.sources.map((s) => s.label).join(' ')}`.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(displayed.length / 30) - 1));
  const prepared = revision.state === 'draft' && !dirty && !pending && rulesIdentity(definition) === rulesIdentity(projection.template.definition);
  useEffect(() => {
    if (prepared && !busy && revealReview.current && reviewPanel.current) {
      revealReview.current = false;
      reviewPanel.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      reviewPanel.current.focus({ preventScroll: true });
    }
  }, [prepared, busy, reviewTarget]);
  const hasChanges = changed.length > 0 || selectionDirty;
  const packageScope = reviewScopeSummary(prepared ? reviewScope : projection.reviewScope, categoryCode);
  const packageCategories = definition.groups.map((group) => categories.find((item) => item.code === group.route)?.name || group.route);
  const disabledReason = busy ? 'Дія виконується. Дочекайтеся результату.' : pending ? 'Застосуйте або відкиньте введення відкритого поля.' : stale ? 'Чинна інтеграція змінилася. Потрібна нова перевірка.' : reviewPending ? 'Завершіть або відкиньте незбережені рішення перевірки.' : '';
  const currentQuestion = projection.questions.find((question) => question.id === context.question);
  const deletionDisabledReason = disabledReason || (dirty || selectionDirty || prepared ? 'Спочатку завершіть або відкиньте підготовку правил та відповідностей. Повне видалення має окрему перевірку.' : '');
  const deletionContext = {categoryCode,revision,isAdministrator:isActualAdministrator(auth),permissions:auth.permissions,disabledReason:deletionDisabledReason,activeReviewKey:activeDeletionReview,onReviewChange:setActiveDeletionReview,
    onCompleted:() => run(async()=>{
      setLoadedField(null); setField(''); replaceParams({field:null});
      const {data}=await api.get(`${root}/categories/${categoryCode}`,{params:{bindingRevisionId:revision.id,...(routeKey ? {routeKey} : {}),rowId}});
      if(alive.current) { setProjection(data); setMessage('Вилучення з обох активних каталогів підтверджено. Історію збережено; майбутні SKU схеми публікуються окремо.'); }
    })};
  const durableResult = revision.state === 'published' && (applied || params.get('binding') === revision.id && params.get('source') === revision.id);
  const nativeUpgrade = registry?.nativeCharacteristicsUpgrade;
  const canUpgradeNative = canManage && nativeUpgrade?.targetContract === 'public-product-characteristics-v1' && nativeUpgrade.supportedEvaluatorVersions?.includes(definition.evaluatorVersion);
  const namesUpgrade = registry?.effectiveNamesUpgrade;
  const canUpgradeNames = canManage && namesUpgrade?.supportedEvaluatorVersions?.includes(definition.evaluatorVersion) && !definition.nameReadiness;
  const fieldRule = (attribute) => summary(definition, at(definition, ['groups', groupIndex, 'rows', rowIndex, 'cells', attribute.target]));
  return <div className={`mc-category-content${field ? ' has-editor' : ''}`}>
    <section className="mc-fields space-y-4" inert={Boolean(activeDeletionReview)}>
      <header><h2>{initial.category.name}</h2><p className="mc-help">{tab === 'placement' ? 'Виберіть розділи магазину, у яких мають бути товари.' : tab === 'text' ? 'Виберіть назву або опис і відредагуйте текст.' : 'Натисніть на характеристику, щоб вибрати, що передавати з нашого менеджера.'}</p></header>
      <RetiredCatalogNotice availability={revision.catalogAvailability} categoryCode={categoryCode} />
      <section className="mc-scope-summary" aria-label="Обсяг редагування та перевірки">
        <p><strong>Редагуємо:</strong> {initial.category.name} · {rowId === 'english' ? 'EN' : 'UA'}{currentField ? ` · ${currentField.label}` : ''}. Змінених полів: {changed.length}{selectionDirty ? ' · є вибрані відповідності' : ''}.</p>
        <p><strong>Перевірка й застосування:</strong> увесь пакет правил ({packageCategories.length} категорій).</p>
        {packageScope ? <p role="status">Непідтверджених відповідностей: {packageScope.total}. У цій категорії: {packageScope.local}. В інших категоріях: {packageScope.otherCount}{packageScope.otherCount > 0 && ` (${packageScope.otherCategories.map((code) => categories.find((item) => item.code === code)?.name || code).join(', ')})`}. {packageScope.otherCount > 0 && 'Вони також блокують застосування пакета.'}</p> : <p>Повний перелік перешкод пакета ще не перевірено. Відсутність локальних попереджень не підтверджує готовність пакета.</p>}
        <MagentoDetails summary="Обсяг і наслідки перевірки">{() => <>
          <p>Категорії пакета: {packageCategories.join(', ')}.</p>
          <p>Перевірка збереже чернетку й підготує неактивну версію правил. Остаточне застосування окремо перевіряє всі категорії та товари пакета.</p>
          <p>Це збережений стан відповідностей. Структурні перешкоди й вплив на товари додатково перевіряються перед застосуванням.</p>
        </>}</MagentoDetails>
      </section>
      {(context.productId || context.question || context.path) && <section className="mc-repair-context" aria-label="Задача цього товару">
        <p><strong>Виправлення для конкретного товару</strong>{context.question && <> · {currentQuestion?.label || 'Характеристика з проблеми'}{context.value !== undefined ? `: ${localValueLabel(projection.questions, context.question, context.value)}` : ''}</>}</p>
        {context.path && <p>Шлях магазину: {context.path.replaceAll('/', ' → ')}</p>}
        {context.returnTo && <Link className="mc-field-link" to={context.returnTo}>Повернутися до проблеми товару</Link>}
        <small>Після застосування перевірте результат цього товару в Magento.</small>
      </section>}
      <p className="mc-work-state" role="status">{dirty || selectionDirty ? 'Є незбережені зміни.' : retired ? 'Історичну TEST чернетку не можна застосувати.' : prepared ? 'Підготовку збережено. Ще не застосовано.' : family ? 'Чернетку збережено. Ще не застосовано.' : durableResult ? 'Застосовано в Amber. Доставку Magento перевіряємо окремо.' : 'Переглядаємо чинні збережені правила.'}</p>
      {context.returnTo && !(context.productId || context.question || context.path) && <Link className="mc-field-link" to={context.returnTo}>Повернутися до проблеми товару</Link>}
      {initial.category.operational?.count > 0 && <Notice tone="warning"><p>Синхронізацію зупинено для товарів цієї категорії: {initial.category.operational.count}. Відкрийте список, щоб побачити причину та виправити конкретний товар.</p><Link className="btn btn-outline" to={`/attention?category=${encodeURIComponent(categoryCode)}`}>Показати товари з проблемами ({initial.category.operational.count})</Link></Notice>}
      {stale && !retired && <Notice tone="warning">Чинна інтеграція змінилася. Ваше введення залишено у формі. Підготовка потребує порівняння з новою версією; автоматичного перезапису немає. <Link className="underline" to={`/admin/magento?category=${categoryCode}`}>Відкрити чинну інтеграцію</Link></Notice>}
      {error && <Notice tone="error">{error}</Notice>}{(message || prepared && reviewTarget === 'categories') && <Notice tone="success">{prepared && reviewTarget === 'categories' ? reviewProgress || 'Читаємо збережені підтвердження…' : message}</Notice>}
      {projection.routes.length > 1 && <label className="mc-label">Вид товару / набір Magento<select className="input" value={routeKey || ''} disabled={busy || pending} onChange={(e) => scope(e.target.value, rowId)}>{projection.routes.map((route) => <option key={route.routeKey} value={route.routeKey}>{routeLabel(route, projection.questions)}</option>)}</select></label>}
      {projection.routes.length === 1 && projection.routes[0].setName !== initial.category.name && <p className="mc-help">Поля для товарів: <strong>{projection.routes[0].setName}</strong></p>}
      {!projection.routes.length && <Notice>Категорію ще не підключено до набору Magento. <Link className="underline" to={`/admin/magento/prepare?category=${categoryCode}&intent=connect`}>Налаштувати підключення</Link></Notice>}
      {canManage && (hasChanges || prepared || family) && <section className="mc-change-bar space-y-3" aria-label="Підготовлені зміни">
        <h3 className="font-semibold">{hasChanges || family ? 'Ваші зміни' : 'Перевірка відповідностей'}{changed.length > 0 ? `: ${changed.length}` : ''}{selectionDirty ? ' · вибрані відповідності' : ''}</h3>
        {changed.map((change) => <p key={`${change.field}:${change.rowId}`}>{projection.attributes.find((a) => a.target === change.field)?.label || change.field} · {change.rowId === 'english' ? 'EN' : 'UA'}</p>)}
        {(!prepared || selectionDirty) && <div className="mc-actions">{canPublish ? <button type="button" className="btn btn-primary" disabled={busy || pending || stale || reviewPending} onClick={() => run(prepare)}>Перевірити зміни</button> : <button type="button" className="btn btn-primary" disabled={busy || pending || stale} onClick={() => run(async () => { await save(); setMessage('Чернетку збережено. Чинна інтеграція ще не змінена.'); })}>Зберегти чернетку</button>}</div>}
        {prepared && !reviewReady && !selectionDirty && <button type="button" className="btn btn-primary" disabled={Boolean(disabledReason)} onClick={() => { reviewPanel.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); reviewPanel.current?.focus({ preventScroll: true }); }}>Продовжити перевірку відповідностей</button>}
        {disabledReason && <p role="status">{disabledReason}</p>}
        <p className="mc-help">{prepared ? 'Перевірте відповідності нижче й застосуйте зміни.' : 'Перевірка збереже вашу роботу й покаже, що зміниться для товарів.'}</p>
        {canPublish && <MagentoDetails summary="Зберегти й продовжити пізніше">{() => <button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(async () => { await save(); setMessage('Чернетку збережено. Чинна інтеграція ще не змінена.'); })}>Зберегти чернетку</button>}</MagentoDetails>}
        {!canPublish && <p className="text-sm">Збережену чернетку може продовжити користувач із правами публікації та перегляду експорту.</p>}
        {definition.outputContract !== COLUMN_CONTRACT && <MagentoDetails summary="Підключення додаткових полів">{() => <><p>Для додавання поля потрібне явне оновлення формату чернетки. Поточна публікація зберігається.</p><button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(async () => { const next = await save(); const draft = (await templates.upgrade(next.id, { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash })).data; setFamily({ ...next, draft }); setDefinition(draft.definition); setSavedDefinition(draft.definition); setMessage('Формат чернетки оновлено. Потрібно повторно перевірити відповідності перед застосуванням.'); })}>Оновити формат чернетки</button></>}</MagentoDetails>}
      </section>}
      <nav className="mc-tabs" aria-label="Поля категорії">{[['attributes', 'Характеристики'], ['text', 'Назва й описи'], ['placement', 'Категорії магазину']].map(([value, label]) => <button type="button" key={value} disabled={busy || pending} aria-pressed={tab === value} onClick={() => { setTab(value); setPage(0); setShowService(false); replaceParams({ view: value, tab: null, path: null }); }}>{label}</button>)}<label>Мова<select aria-label="Мова полів" className="input" value={rowId} disabled={busy || pending} onChange={(e) => scope(routeKey, e.target.value)}><option value="base">UA</option><option value="english">EN</option></select></label></nav>
      {tab === 'placement' ? <section className="mc-placement space-y-3" aria-label="Категорії магазину для товарів">
        <h3 className="font-semibold">Де показувати товари «{initial.category.name}»</h3>
        <p>{applied ? context.returnTo ? 'Розділи збережено. Наступний крок — «Повернутися до проблеми товару» вище й «Перевірити товар у Magento».' : 'Розділи збережено. Стан синхронізації товарів доступний у вкладці «Стан доставки».'
          : prepared ? reviewReady ? 'Відповідності підтверджено. Нижче — перевірка впливу на товари та застосування змін.' : 'Продовжіть перевірку нижче: там показано всі відповідності, які ще блокують застосування.' : 'Наступний крок — «Перевірити відповідність розділів». Після перевірки підтвердьте запропоновані розділи й натисніть «Застосувати зміни».'}</p>
        {!prepared && !applied && <p className="mc-help">Нижче — збережені налаштування категорії. Підтверджений розділ у цьому списку ще не означає, що конкретний товар пройшов перевірку.{context.productId && ' Перевірка врахує товар, з якого ви перейшли.'}</p>}
        <div className="mc-actions">{canPublish && <button className="btn btn-primary" disabled={busy || pending || stale || reviewPending} onClick={() => checkBinding('categories')}>{busy ? 'Перевіряємо розділи…' : prepared ? 'Продовжити перевірку розділів' : 'Перевірити відповідність розділів'}</button>}
          {projection.attributes.some((a) => a.code === 'categories') && <button className="btn btn-outline" disabled={busy || pending} onClick={() => chooseField('categories')}>Змінити правило розміщення</button>}
        </div>
        <div className="space-y-3">
          {(projection.placements || []).map((entry) => <div key={entry.id} className="mc-placement-row"><strong>{entry.label?.split('/').join(' › ')}</strong><p>{entry.reviewState === 'approved' ? prepared ? 'Підтверджено. Очікує застосування змін.' : 'Підтверджено в збережених налаштуваннях' : entry.reviewState === 'blocked' ? 'Передавання в цей розділ заблоковано' : entry.identity ? 'Розділ знайдено в Magento. Потрібно підтвердити, що обрано правильний.' : entry.candidates?.length > 1 ? 'Знайдено кілька розділів. Виберіть правильний у перевірці відповідностей.' : 'Розділ не знайдено. Перевірте шлях у правилі або додайте розділ.'}</p></div>)}
          {!projection.placements?.length && <p>Для цієї мови немає збережених відповідностей розділів магазину.</p>}
        </div>
        {canManage && <MagentoDetails summary="Додати відсутній розділ Magento">{() => <><p>Створення розділу потребує окремої перевірки точного батьківського розділу.</p><Link className="mc-field-link" to={`/admin/magento/prepare?category=${categoryCode}&intent=subcategory`}>Відкрити створення розділу</Link></>}</MagentoDetails>}
      </section> : <>
      <p className="mc-help">«Непідтверджені відповідності» рахує зв’язки значень у всьому пакеті. «Перевірити» рахує поля цієї вкладки: їхній текст, правило або спосіб передавання теж може потребувати уваги, навіть коли всі зв’язки підтверджено.</p>
      <div className="mc-status-counts" aria-label="Стан полів"><span>Підключено: <strong>{tabFields.filter((a) => !a.service && a.editable && a.state === 'connected').length}</strong></span><span>Не підключено: <strong>{tabFields.filter((a) => !a.service && a.editable && a.state === 'unmapped').length}</strong></span><span>Перевірити: <strong>{tabFields.filter((a) => !a.service && a.editable && a.state === 'review').length}</strong></span></div>
      <div className="mc-actions"><label className="mc-label">Пошук поля<input className="input" type="search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></label><label className="mc-label">Показати<select className="input" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}><option value="all">Усі</option><option value="unmapped">Без прив’язки</option><option value="review">Потребують перевірки</option></select></label></div>
      <div className="mc-table-scroll"><table className="mc-field-table"><caption className="sr-only">Поля Magento та джерела менеджера</caption><thead><tr><th>У Magento</th><th>{tab === 'text' ? 'Наш текст' : 'З нашого менеджера'}</th><th>Стан</th></tr></thead><tbody>{displayed.slice(currentPage * 30, (currentPage + 1) * 30).map((attribute) => <tr key={attribute.code} className={field === attribute.code ? 'is-selected' : ''}>
        <th scope="row"><button type="button" className="mc-field-link" onClick={() => chooseField(attribute.code)}>{attribute.label}</button></th>
        <td>{tab === 'text' && attribute.configured ? <span className="mc-text-summary" title={fieldRule(attribute)}>{fieldRule(attribute)}</span> : attribute.sources.length ? [...new Set(attribute.sources.map((s) => s.label))].join(', ') : attribute.configured ? 'Налаштоване значення' : <span className="mc-missing">Оберіть характеристику</span>}</td>
        <td className="mc-state-cell"><span className={`mc-state mc-state-${attribute.state}`}>{changed.some((change) => change.field === attribute.target && change.rowId === rowId) ? 'Є зміна' : !attribute.editable ? 'Лише перегляд' : attribute.unresolved ? `Перевірити відповідності: ${attribute.unresolved}` : messages[attribute.state]}</span>
          {attribute.state === 'review' && <><small>{attribute.reviewReasons?.[0]?.message || 'Відкрийте поле, щоб перевірити його відповідності та поведінку.'}</small><button type="button" className="mc-field-link" onClick={() => chooseField(attribute.code)}>Що виправити</button></>}
          {attribute.state === 'empty' && <><small>Порожній текст не передається в Magento.</small>{attribute.editable && <button type="button" className="mc-field-link" onClick={() => chooseField(attribute.code)}>Додати текст</button>}</>}
        </td>
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
      </>}
      {canManage && <MagentoDetails summary="Підготувати зміну структури">{() => <div className="mc-actions">{[['subcategory', 'Розділ магазину'], ['attribute', 'Характеристика'], ['option', 'Значення характеристики'], ['connect', 'Підключення категорії']].map(([intent, label]) => <Link key={intent} className="mc-field-link" to={`/admin/magento/prepare?${new URLSearchParams({ ...context, category: categoryCode, intent })}`}>{label}</Link>)}</div>}</MagentoDetails>}
      {canUpgradeNative && <MagentoDetails summary="Підтримка характеристик нових товарів">{() => <div className="space-y-3"><p>Підготуйте підтримку збережених характеристик товарів, створених без старої SKU-схеми. Це збереже окрему чернетку; правила інших категорій і чинна доставка зміняться лише після перевірки та застосування всього пакета.</p><button type="button" className="btn btn-outline" disabled={Boolean(disabledReason)} onClick={() => run(async () => { const next = await save(); const updated = (await templates.upgrade(next.id, { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash, targetContract: nativeUpgrade.targetContract })).data; setFamily({ ...next, draft: updated }); setDefinition(updated.definition); setSavedDefinition(updated.definition); setReviewReady(false); setMessage('Підтримку нових товарів збережено у чернетці. Перевірте й застосуйте зміни пакета.'); })}>Підготувати підтримку характеристик нових товарів</button></div>}</MagentoDetails>}
      {canUpgradeNames && <section className="space-y-2" aria-label="Повні назви товарів"><p>Якщо шаблон формує UA/EN, ручні назви предмета не потрібні. Для решти товарів можна зберегти повні назви або явно імпортувати перевірену пару Magento.</p><button type="button" className="btn btn-outline" disabled={Boolean(disabledReason)} onClick={() => run(async () => {
        const next = await save(); const updated = (await templates.upgrade(next.id, { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash, targetContract: namesUpgrade.targetContract })).data;
        setFamily({ ...next, draft: updated }); setDefinition(updated.definition); setSavedDefinition(updated.definition); setReviewReady(false);
        setMessage('Підтримку повних назв збережено в чернетці. Перевірте весь пакет перед застосуванням.');
      })}>Підготувати підтримку повних назв</button></section>}
      {tab === 'text' && canManage && auth.permissions.includes('exports.view') && <MagentoDetails summary="Приклад тексту на товарі">{() => <section className="space-y-3" aria-label="Приклад текстових шаблонів"><SampleProducts search={searchSamples} selected={samples} onChange={(next) => { setSamples(next.slice(-1)); setPreview(null); }} /><button type="button" className="btn btn-outline" disabled={busy || pending || !samples.length || stale} onClick={() => run(async () => { const next = await save(); const { data } = await templates.preview(next.id, { expectedRevision: next.draft.revision, expectedDefinitionHash: next.draft.definitionHash, productIds: samples.map((p) => p.id) }); setPreview(data); })}>Перевірити приклад</button>{preview && <SampleResult preview={preview} />}</section>}</MagentoDetails>}
      {prepared && <>
        <div ref={reviewPanel} tabIndex={-1}><MagentoWorkspaceReview revision={revision} categoryCode={categoryCode} categories={categories} questions={projection.questions} focusTarget={reviewTarget} selections={selections} disabled={!canManage || busy || stale} repairContext={context} onScopeChange={setReviewScope} onReadyChange={setReviewReady} onProgressChange={setReviewProgress} onPendingChange={setReviewPending} onChanged={reviewChanged} /></div>
        {canPublish && <MagentoDetails summary="Приклад на товарі">{() => <><button type="button" className="btn btn-outline" onClick={() => setProductChecks(!productChecks)}>{productChecks ? 'Сховати перевірку товарів' : 'Вибрати товар для перевірки'}</button>{productChecks && <MagentoProductChecks key={`${revision.id}:${revision.revision}`} revision={revision} categoryCode={categoryCode} onRepresentative={(example) => setRepresentatives((current) => [...current.filter((e) => e.routeKey !== example.routeKey), { ...example, revision: revision.revision }])} />}</>}</MagentoDetails>}
        {reviewReady ? <MagentoPublicationActions compact editScope={{ categoryName: initial.category.name, language: rowId === 'english' ? 'EN' : 'UA', changedCount: changed.length }} autoPreview={checkRequested && reviewReady} disabled={busy || stale || selectionDirty || reviewPending} revision={revision} currentPublishedId={activePublication?.id} definition={definition} registry={registry} categories={categories} repairContext={context} onRepresentative={(example) => setRepresentatives((current) => [...current.filter((e) => e.routeKey !== example.routeKey), { ...example, revision: revision.revision }])} representatives={representatives.filter((e) => e.revision === revision.revision)} onPublished={(next) => {
          setRevision(next); setBase({ ...projection, revision: next, template: { ...projection.template, definition } });
          setFamily(null); creationKey.current = null; setSavedDefinition(definition); setSelections({}); setSelectionDirty(false);
          replaceParams({ binding: next.id, source: next.id, ruleDraft: null });
          setApplied(true);
          setMessage(context.returnTo ? 'Зміни застосовано. Поверніться до проблеми товару й натисніть «Перевірити товар у Magento», щоб перевірити решту перешкод.' : 'Зміни застосовано в Amber. Результат доставки відстежується окремо.'); onPublished(next);
          api.get(`${root}/categories/${categoryCode}`, { params: { bindingRevisionId: next.id, ...(routeKey ? { routeKey } : {}), rowId } }).then(({ data }) => { if (alive.current) setProjection(data); }).catch((cause) => { if (alive.current) setError(fail(cause)); });
        }} /> : <p className="mc-help">Підтвердьте відповідності вище. Після цього тут з’явиться перевірка впливу та застосування змін.</p>}
      </>}
      {durableResult && <MagentoPublicationActions compact revision={revision} currentPublishedId={activePublication?.id} repairContext={context} onPublished={onPublished} />}
      {revision.state === 'published' && isActualAdministrator(auth) && canPublish && auth.permissions.includes('exports.create') && <section className="space-y-3"><button type="button" className="btn btn-outline" onClick={() => setNamesOpen(!namesOpen)}>Застосувати назви до чинних товарів</button>{namesOpen && <MagentoControlledActions revision={revision} currentPublishedId={activePublication?.id} categoryCode={categoryCode} kind="name_rule" />}</section>}
      {busy && <LoadingState compact label="Зберігаємо й перевіряємо підготовку…" />}
      <MagentoDetails summary="Дані Magento та додаткові налаштування">{() => <div className="space-y-3"><p>Структура Magento: {date(projection.observedAt)}{projection.liveObservation && ' · щойно прочитано'}</p><div className="mc-actions"><button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(async () => { const { data } = await api.post(`${root}/categories/${categoryCode}/observation`, { bindingRevisionId: revision.id, ...(routeKey ? { routeKey } : {}), rowId }); setProjection(data); setMessage('Дані Magento оновлено. Перегляньте нові поля та зміни, що потребують перевірки.'); })}>{busy ? 'Читаємо Magento…' : 'Оновити структуру Magento'}</button><Link className="text-sm underline" to={`/admin/magento/categories/${categoryCode}?tab=placement`}>Розміщення в магазині</Link>{canManage && canPublish && !hasChanges && !prepared && <button type="button" className="btn btn-outline" disabled={busy || pending || stale} onClick={() => run(prepare)}>Змінити поведінку передавання полів</button>}</div></div>}</MagentoDetails>
    </section>
    {field && <FieldSurface busy={busy || Boolean(activeDeletionReview)} suspended={Boolean(discardPanel)} onClose={() => chooseField('')}>
      {fieldError && <Notice tone="error">{fieldError}</Notice>}{currentField?.configured && !fieldData && !fieldError && <LoadingState compact label="Читаємо поле…" />}
      {currentField && <>
        {currentField.state === 'review' && <section className="mc-field-task space-y-3" aria-label="Що виправити в полі"><h3 className="font-semibold">Чому поле потребує перевірки</h3>
          {currentField.reviewReasons?.length ? currentField.reviewReasons.map((reason) => <p key={reason.kind}>{reason.message}</p>) : <p>Перевірте відповідність поля, його значень і спосіб передавання.</p>}
          {canPublish && <><p className="mc-help">Виправте текст або значення нижче. Якщо правило вже правильне, відкрийте підтвердження прив’язки.</p><button className="btn btn-primary" disabled={busy || pending || stale || reviewPending} onClick={() => checkBinding(currentField.target)}>Перевірити прив’язку цього поля</button></>}
        </section>}
        {currentField.state === 'empty' && <Notice>Це необов’язкове поле порожнє. Додайте текст, якщо хочете передавати його в магазин.</Notice>}
        {currentField.restriction && <Notice>{currentField.restriction}</Notice>}
        {currentField.service && !currentField.restriction && <Notice>Це службове поле Magento. Його правило доступне в додаткових налаштуваннях; воно не є описом або характеристикою для покупця.</Notice>}

        {fieldData && <CatalogDeletionEntry {...deletionContext} field={{...fieldData,attribute:currentField}} questions={projection.questions}/>}
        {!fieldConfigured && currentField.editable && canManage && <section className="space-y-3"><h3>{currentField.label}</h3><p>Оберіть джерело й поведінку поля. Інша мова залишиться порожньою до окремого налаштування.</p><button type="button" className="btn btn-primary" disabled={busy || stale || definition.outputContract !== COLUMN_CONTRACT} onClick={() => { setDefinition(columnChange(definition, groupIndex, 'add', null, currentField.code)); setPreview(null); }}>Підключити поле</button>{definition.outputContract !== COLUMN_CONTRACT && <p>Спочатку оновіть формат чернетки в підготовлених змінах.</p>}</section>}
        {fieldConfigured && registry && <ColumnInspector key={`${field}:${rowId}:${routeKey}`} integration embedded localOnly simple textOnly={currentField.text} title={currentField.label} contextLabel={initial.category.name} definition={definition} groupIndex={groupIndex} rowIndex={rowIndex} column={currentField.target} registry={registry} loadSource={loadSource}
          initialPanel={context.question && context.value !== undefined ? 'mapping' : 'rule'}
          extraPanel={fieldData?.entries.some((entry) => entry.kind === 'option') ? { title: 'Відповідність у Magento', pending: mappingPending,
            render: ({ active, rulePending }) => <FieldMappings active={active} rulePending={rulePending} field={{ ...fieldData, attribute: currentField }} questions={projection.questions} context={context} selections={fieldSelections ?? selections} setSelections={setLocalSelections} disabled={!canManage || busy || Boolean(activeDeletionReview) || stale || !currentField.editable} deletionContext={deletionContext} /> } : undefined}
          suspended={busy || Boolean(activeDeletionReview) || Boolean(discardPanel)} readOnly={!canManage || stale || !currentField.editable}
          onPendingChange={setPending} onRequestClose={() => chooseField('')} onCancel={() => chooseField('')}
          onApply={(next, base) => { if (base !== definition) return false; assertCategoryScope(definition, next, categoryCode, rowId); setDefinition(next); if (mappingPending) { setSelections(fieldSelections); setSelectionDirty(true); } setFieldSelections(null); setPending(false); setPreview(null); setField(''); replaceParams({ field: null }); return true; }} />}
        {currentField.policy && <div className="mc-help"><p>{deliveryPolicies[currentField.policy]}</p><p>{deliveryPolicyEffect(currentField.policy, currentField.target)}</p></div>}
        {!fieldConfigured && <MagentoDetails>{() => <p>Код: {currentField.code} · {currentField.inputType || 'службове поле'}</p>}</MagentoDetails>}
        {!fieldConfigured && <button type="button" className="btn btn-outline" onClick={() => chooseField('')}>Закрити поле</button>}
      </>}
    </FieldSurface>}
    {navigation.prompt}
    {discardPanel && <WorkspaceDialog title="Незбережене поле" onClose={() => setDiscardPanel(null)}><h2>Є незастосоване введення поля</h2><p>Застосуйте його до чернетки або явно відкиньте перед переходом.</p><button type="button" className="btn btn-outline" onClick={() => setDiscardPanel(null)}>Залишитися</button><button type="button" className="btn btn-outline" onClick={() => { discardPanel(); setDiscardPanel(null); }}>Відкинути введення поля</button></WorkspaceDialog>}
  </div>;
}

export default function MagentoCategoryWorkspace({ categories, activePublication, onPublished }) {
  const auth = useAuth();
  const path = useParams(); const [params] = useSearchParams(); const [search, setSearch] = useState('');
  const [categoryChoicesOpen, setCategoryChoicesOpen] = useState(false);
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
    const selectedRead = api.get(`${root}/categories/${categoryCode}`, { signal: controller.signal, params: query });
    const sameBaseline = query.bindingRevisionId === baseQuery.bindingRevisionId && !query.routeKey && query.rowId === 'base';
    Promise.all([selectedRead, sameBaseline ? selectedRead : api.get(`${root}/categories/${categoryCode}`, { signal: controller.signal, params: baseQuery })]).then(([selected, baseline]) => {
      if (!controller.signal.aborted) { setOwnedScope(null); setLoaded({ categoryCode, scopeKey, editorKey: scopeKey, data: selected.data, baseline: baseline.data }); setError(''); }
    }).catch((cause) => { if (!controller.signal.aborted) setError(fail(cause)); });
    return () => controller.abort();
    // Editing/restoration owns its exact draft; refreshing the shell cannot replace local input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, location.key]);
  const data = !ownedScope && loaded?.scopeKey === scopeKey || owned ? loaded?.data : null;
  const filtered = categories.filter((c) => `${c.name} ${c.code}`.toLocaleLowerCase('uk').includes(search.trim().toLocaleLowerCase('uk')));
  return <div className="mc-workspace">
    <aside className="mc-categories" aria-label="Категорії менеджера"><h2>Категорії</h2><button type="button" className="mc-category-picker btn btn-outline" aria-expanded={categoryChoicesOpen || !categoryCode} aria-controls="mc-category-choices" onClick={() => setCategoryChoicesOpen((open) => !open)}>{categories.find((item) => item.code === categoryCode)?.name || 'Оберіть категорію'} · змінити категорію</button><div id="mc-category-choices" className={`mc-category-choices${categoryChoicesOpen || !categoryCode ? ' is-open' : ''}`}>{auth.permissions.includes('catalog.manage') && <Link className="mc-field-link" to="/admin/magento/categories/new">Додати категорію менеджера</Link>}<label className="mc-label">Пошук категорії<input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label><nav>{filtered.map((c) => <Link key={c.code} aria-current={c.code === categoryCode ? 'page' : undefined} onClick={() => setCategoryChoicesOpen(false)} to={`/admin/magento?category=${encodeURIComponent(c.code)}`}><strong>{c.name}</strong><small>{c.unboundCount == null ? 'Відповідності — у категорії' : `Ще не передаємо: ${c.unboundCount}`}</small>{c.operational.count > 0 && <small>Проблеми товарів: {c.operational.count}</small>}</Link>)}</nav>{!filtered.length && <p>Категорій за цим пошуком немає.</p>}</div></aside>
    {!categoryCode ? <EmptyState title="Оберіть категорію менеджера">Побачите поля Magento, наші характеристики та текстові шаблони.</EmptyState> : error ? <Notice tone="error">{error}</Notice> : !data ? <LoadingState label="Читаємо категорію…" /> : !data.template || data.groupIndex < 0 ? <EmptyState title={data.category.name}>Категорію ще не включено до правил Magento. <Link className="underline" to={`/admin/magento/prepare?category=${categoryCode}&intent=connect`}>Налаштувати підключення</Link></EmptyState> : <CategoryEditor key={loaded.editorKey} categories={categories} initial={{ ...data, category: { ...data.category, operational: categories.find((c) => c.code === categoryCode)?.operational } }} baseline={loaded.baseline.template ? loaded.baseline : data} activePublication={activePublication} onPublished={onPublished} onScopeCommit={(nextScope) => setOwnedScope((current) => ({ key: nextScope, priorLocationKey: location.key, scopes: [...new Set([scopeKey, ...(current?.priorLocationKey === location.key ? current.scopes : []), nextScope])], editorKey: loaded.editorKey }))} />}
  </div>;
}
