import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { exportTemplatesApi as api } from '../api/export-templates-api';
import { DefinitionEditor } from '../components/export-templates/DefinitionEditor';
import { parseProductIds, fieldLabels } from '../lib/export-template-editor';
import { getApiError } from '../lib/http-error';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation';
import { SourceDiagnostics } from '../components/export-templates/SourceDiagnostics';
import { SampleProducts } from '../components/export-templates/SampleProducts';
import { PreviewTable } from '../components/export-templates/PreviewTable';
import { fieldsForSource } from '../lib/export-template-attributes';
import { TemplateLocalNav, TemplateWorkspaceShell } from '../components/workspace/TemplateWorkspaceShell';
import { WorkspaceHeader } from '../components/workspace/WorkspacePrimitives';
import { WorkspaceDialog } from '../components/workspace/WorkspaceDialog';
import { TemplateRegistry } from '../components/export-templates/TemplateRegistry';

const templateBase = '/admin/export-templates';
function templateRoute(location) {
  const parts = location.pathname.slice(templateBase.length).split('/').filter(Boolean);
  const id = parts[0];
  return { id: id && !['system', 'new'].includes(id) ? decodeURIComponent(id) : null,
    screen: !id ? 'list' : id === 'system' ? 'system' : id === 'new' ? 'create' : 'editor',
    view: parts[1] === 'check' ? 'check' : parts[1] === 'versions' ? 'versions' : 'fields',
    versionId: new URLSearchParams(location.search).get('version') || '' };
}

function Diagnostics({ error, definition, registry, onOpenSource, showSources = true }) {
  if (!error) return null;
  const data = error.response?.data;
  return <div role="alert" className="danger-panel p-3 space-y-2">
    <p>{data?.code === 'TEMPLATE_DRAFT_CONFLICT'
      ? 'На сервері вже новіша чернетка. Ваші локальні зміни збережено у формі. Автоматичного перезапису немає.'
      : data?.code === 'TEMPLATE_KEY_CONFLICT' ? 'Ключ уже зайнятий. Перевірте список шаблонів або змініть ключ у додаткових налаштуваннях.'
        : data?.code === 'TEMPLATE_SOURCE_INVALID' ? 'Шаблон ще не готовий до публікації.'
          : data?.code === 'TEMPLATE_INVALID' ? 'Помилка структури або безпеки визначення. Перевірте правила; ваші локальні зміни залишилися у формі.' : 'Не вдалося виконати дію. Ваші локальні зміни залишилися у формі.'}</p>
    {showSources && <SourceDiagnostics diagnostics={data?.details?.diagnostics} definition={definition} registry={registry} onOpenSource={onOpenSource} showHeading={false} />}
    <details><summary>Технічні подробиці</summary>{data?.code && <p>{data.code}</p>}<p>{getApiError(error)}</p></details>
    {data?.details?.missingProductIds && <p>Не знайдено ID: {data.details.missingProductIds.join(', ')}. Жоден ID не пропущено.</p>}
  </div>;
}

function DraftPreview({ preview, stale, selectedField }) {
  const result = preview.result;
  return <section className="rounded border border-blue-300 bg-blue-50 p-4 space-y-3" aria-label="Тест чернетки">
    <h2 className="font-semibold">Результат перевірки · ревізія {preview.revision}</h2>
    <p>Товари: {preview.sampleIds?.join(', ')}. {stale ? 'Застарілий результат — збережіть зміни та повторіть перевірку.' : 'Результат збереженої ревізії. Експорт не створено.'}</p>
    {preview.sampleProducts?.map((product) => <p key={product.productId}>{product.productId} · {product.category} · {product.sku}</p>)}
    {preview.globalSourceDiagnostics?.length > 0 && <>
      <p>{stale ? 'Для перевіреної ревізії:' : 'Результат показано для вибраних товарів.'} У шаблоні залишилися проблеми інших категорій; публікація заблокована.</p>
      <p>Питання до публікації показано окремо в повній перевірці шаблону.</p>
    </>}
    <p>Представлено: {result.representedCount}; готові: {result.readyCount}</p>
    {result.errors?.length > 0 && <p>Значення товарів не готові до експорту. Це окрема перевірка від підтвердження джерел шаблону.</p>}
    {(result.errors || []).map((p, i) => <div key={i} className="text-red-800"><p>{p.sku}: перевірте значення товару в зазначених полях.</p>
      {(p.fields || []).map((f, index) => <div key={index}><p>{fieldLabels[f.field] || (f.field === 'sourceSupport' ? 'Підтримка джерел' : f.field)}: {/[A-Z]{2,}_[A-Z_]+|Unverified|semantic value|source reference/i.test(f.message || '') || !/[А-Яа-яІіЇїЄєҐґ]/.test(f.message || '') ? 'Не вдалося підтвердити значення для експорту.' : f.message}</p>
        <details><summary>Технічні подробиці</summary><pre>{JSON.stringify(f, null, 2)}</pre></details></div>)}</div>)}
    {(result.provisionalArtifacts || result.artifacts || []).map((a) => <div key={a.groupCode}><PreviewTable key={a.groupCode + '/' + selectedField} artifact={a} selectedField={selectedField} />
      <details><summary>CSV / технічний перегляд</summary><pre className="max-h-80 overflow-auto whitespace-pre text-xs">{a.csvContent}</pre></details></div>)}
  </section>;
}

function TemplateWorkspace({ permissions }) {
  const location = useLocation(); const navigate = useNavigate();
  const route = templateRoute(location);
  const { screen, view, versionId } = route;
  const familyPath = (id = route.id, tab = view, version = versionId) => `${templateBase}/${encodeURIComponent(id)}${tab === 'fields' ? '' : '/' + tab}${version ? '?version=' + encodeURIComponent(version) : ''}`;
  const setView = (tab) => navigate(familyPath(route.id, tab));
  const has = (key) => permissions.includes(key);
  const manage = has('export_templates.manage');
  const publish = has('export_templates.publish');
  const activate = has('export_templates.activate');
  const [families, setFamilies] = useState(null);
  const [registry, setRegistry] = useState(null);
  const [activation, setActivation] = useState(null);
  const [family, setFamily] = useState(null);
  const [definition, setDefinition] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [panelPending, setPanelPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [validation, setValidation] = useState(null);
  const [preview, setPreview] = useState(null);
  const [supportProposal, setSupportProposal] = useState(null);
  const [publishReview, setPublishReview] = useState(null);
  const [productIds, setProductIds] = useState('');
  const [sampleProducts, setSampleProducts] = useState([]);
  const [fieldSelection, setFieldSelection] = useState({ groupIndex: 0, rowIndex: 0, column: 'name' });
  const [focusField, setFocusField] = useState(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [system, setSystem] = useState(null);
  const generation = useRef(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  const permissionKey = permissions.join('|');
  const openSource = (sourceId, coordinate) => {
    const fields = fieldsForSource(definition, sourceId);
    const target = coordinate || fields.find((f) => f.groupIndex === fieldSelection.groupIndex && f.rowIndex === fieldSelection.rowIndex) || fields[0];
    if (target) { setFocusField({ ...target, sourceId }); setView('fields'); }
  };
  const sourceDiagnostics = [...new Map([...(validation?.error?.response?.data?.details?.diagnostics || []), ...(error?.response?.data?.details?.diagnostics || []), ...(preview?.globalSourceDiagnostics || [])].map((item) => [JSON.stringify(item), item])).values()];
  const issueCount = sourceDiagnostics.length || (validation?.error || ['TEMPLATE_INVALID', 'TEMPLATE_SOURCE_INVALID'].includes(error?.response?.data?.code) ? 1 : 0);
  let selectedSamples = [];
  try { selectedSamples = parseProductIds(productIds).map((id) => sampleProducts.find((p) => p.id === id) || { id }); } catch { /* Invalid technical input remains visible and is rejected on submit. */ }
  const previewStale = preview && (dirty || panelPending || preview.revision !== family?.draft.revision || preview.sampleIds?.join(',') !== productIds.trim().split(/[\s,;]+/).map(Number).join(','));

  useEffect(() => {
    generation.current++;
  }, [permissionKey]);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    Promise.all([api.list(), manage ? api.sources() : Promise.resolve({ data: null }), api.activation()]).then(([list, sources, selection]) => {
      if (!current) return;
      setFamilies(list.data.templates); setRegistry(sources.data); setActivation(selection.data);
    }).catch((e) => { if (current) setError(e); });
    return () => { current = false; mounted.current = false; };
  }, [manage]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const clearEvidence = () => { setValidation(null); setPreview(null); setSupportProposal(null); setMessage(''); };
  const edit = (next) => { generation.current++; setDefinition(next); setDirty(true); setValidation(null); setSupportProposal(null); setMessage(''); };
  async function run(label, task, apply, onError) {
    if (operation.current) return;
    if (!document.getElementById('template-definition-form')?.reportValidity() && document.getElementById('template-definition-form')) return;
    operation.current = true;
    const ticket = generation.current;
    setBusy(label); setError(null); setMessage('');
    try {
      const result = await task();
      if (mounted.current && ticket === generation.current) { apply(result.data); return result.data; }
    } catch (e) { if (mounted.current && ticket === generation.current) { if (onError) onError(e); else setError(e); } }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  // Loads may complete out of order; only the latest selected family may apply.
  async function load(id) {
    const ticket = ++generation.current;
    setFamily(null); setDefinition(null); setCandidate(null); setError(null); clearEvidence(); setBusy('Завантаження'); setDirty(false);
    try {
      const response = await api.get(id);
      if (ticket !== generation.current || !mounted.current) return;
      const published = response.data.versions.find((v) => v.id === versionId);
      if (versionId && !published) throw new Error('Опубліковану версію не знайдено.');
      setFamily(response.data); setDefinition(published ? published.definition : response.data.draft.definition);
    } catch (e) { if (ticket === generation.current && mounted.current) setError(e); }
    finally { if (ticket === generation.current && mounted.current) setBusy(''); }
  }
  const precondition = () => ({ expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash });
  const saved = (draft) => {
    setFamily((f) => ({ ...f, draft })); setDefinition(draft.definition); setDirty(false); clearEvidence();
    if (versionId) navigation.commit(() => navigate(familyPath(route.id, view, ''), { replace: true }));
    setFamilies((items) => items?.map((item) => item.id === family.id ? { ...item, draft_revision: draft.revision } : item));
  };
  const selectedVersion = family?.versions?.find((v) => v.id === versionId);
  const exactSaved = family && !dirty && !panelPending && !versionId && !busy;
  const discard = () => {
    setPanelPending(false); setEditorEpoch((v) => v + 1);
    generation.current++; setDirty(false); clearEvidence(); setError(null);
    if (family) setDefinition(family.draft.definition); else { setCandidate(null); setDefinition(null); }
  };
  const save = () => {
    if (!manage || versionId) return false;
    if (panelPending) { setError(new Error('Спочатку застосуйте або скасуйте введені налаштування колонки.')); return false; }
    if (family) return run('Збереження', () => api.save(family.id, { expectedRevision: family.draft.revision, definition }), saved);
    if (!name.trim() || !/^[a-z][a-z0-9_-]{0,79}$/.test(key)) { setError(new Error('Вкажіть назву та сталий ключ шаблону перед збереженням.')); return false; }
    return run('Створення чернетки', () => api.create({ key, displayName: name, definition }), (data) => {
      setFamily({ ...data, versions: [] }); setDefinition(data.draft.definition); setCandidate(null); setDirty(false);
      setFamilies((items) => [...(items || []), { ...data, draft_revision: data.draft.revision, publication_count: 0 }]);
    });
  };
  const navigation = useDirtyNavigation({ dirty: dirty || panelPending, save: manage ? save : null, discard, busy: Boolean(busy),
    shouldBlock: ({ currentLocation, nextLocation }) => {
      const from = templateRoute(currentLocation); const to = templateRoute(nextLocation);
      // Local sections retain the same mounted editor and complete draft. Pending
      // inspector input and transitions to another definition still require a choice.
      return panelPending || !nextLocation.pathname.startsWith(templateBase + '/') || !from.id || from.id !== to.id || from.versionId !== to.versionId;
    } });
  const openVersion = (id) => navigate(familyPath(route.id, view, id));
  const back = () => navigate(templateBase);
  const prepareCandidate = (data) => {
    generation.current++; setFamily(null); setCandidate(data); setDefinition(data.definition); setName('');
    setKey('template-' + crypto.randomUUID()); setDirty(true); clearEvidence();
  };
  async function readProfile(kind) {
    const ticket = ++generation.current;
    setFamily(null); setSystem(null); setError(null); setBusy('Завантаження');
    try {
      const { data } = await (kind === 'system' ? api.system() : api.candidate());
      if (!mounted.current || ticket !== generation.current) return;
      setBusy('');
      if (kind === 'system') setSystem(data); else prepareCandidate(data);
    } catch (e) { if (mounted.current && ticket === generation.current) setError(e); }
    finally { if (mounted.current && ticket === generation.current) setBusy(''); }
  }
  const syncRoute = useEffectEvent(() => {
    if (screen === 'editor') {
      if (family?.id !== route.id) { void load(route.id); return; }
      const published = family.versions.find((v) => v.id === versionId);
      generation.current++; setValidation(null); setPreview(null); setSupportProposal(null); setPanelPending(false); setEditorEpoch((v) => v + 1);
      if (versionId && !published) { setDefinition(null); setError(new Error('Опубліковану версію не знайдено.')); return; }
      setDefinition(published ? published.definition : family.draft.definition);
    } else if (screen === 'system') {
      void readProfile('system');
    } else if (screen === 'create') {
      if (!candidate && manage) void readProfile('create');
    } else {
      if (family) {
        const ticket = generation.current + 1;
        api.list().then(({ data }) => { if (mounted.current && generation.current === ticket) setFamilies(data.templates); }).catch((e) => { if (mounted.current && generation.current === ticket) setError(e); });
      }
      generation.current++; setFamily(null); setCandidate(null); setDefinition(null); setDirty(false); clearEvidence(); setError(null);
    }
  });
  useEffect(() => {
    // Navigation changes presentation; only authorized reads happen here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    syncRoute();
  }, [route.id, screen, versionId]);
  return <TemplateWorkspaceShell>
    {navigation.prompt}
    {screen !== 'editor' && <><Diagnostics error={error} definition={definition} registry={registry} />{busy && <p role="status">{busy}…</p>}</>}
    {screen === 'list' ? <>
      <WorkspaceHeader title="Шаблони експорту" description="Налаштуйте назви, характеристики та порядок полів у файлі." actions={
        manage && <button className="btn btn-primary px-4" disabled={Boolean(busy)} onClick={() => run('Підготовка шаблону', () => api.candidate(), (data) => {
          prepareCandidate(data); navigation.commit(() => navigate(templateBase + '/new'));
        })}>Створити шаблон</button>
      } />
      <TemplateRegistry families={families} manage={manage} busy={Boolean(busy)} error={error} onRefresh={() => run('Оновлення списку', () => api.list(), (data) => setFamilies(data.templates))} onCopy={() => run('Підготовка копії', () => api.candidate(), (data) => { prepareCandidate(data); navigation.commit(() => navigate(templateBase + '/new')); })} />
    </> : screen === 'system' ? <section className="card et-editor-surface">
      <button className="et-link" onClick={back}>← До шаблонів</button><h1>Magento — поточний системний</h1>
      <p>Лише перегляд · використовується звичайним експортом.</p>
      {manage && system && <button className="btn btn-primary px-4" disabled={Boolean(busy)} onClick={() => run('Підготовка копії', () => api.candidate(), (data) => { prepareCandidate(data); navigation.commit(() => navigate(templateBase + '/new')); })}>Створити редаговану копію</button>}
      {system && <DefinitionEditor definition={system.definition} readOnly registry={registry} />}
    </section> : screen === 'create' ? !manage ? <p>Немає дозволу на створення шаблону.</p> : <section className="card et-create">
      <button className="et-link" onClick={back}>← До шаблонів</button><h1>Новий шаблон</h1><p className="et-muted">Незбережена чернетка на основі Magento. Вкажіть назву, щоб створити її.</p>
      <label>Назва шаблону<input autoFocus className="input" disabled={Boolean(busy)} value={name} onChange={(e) => { generation.current++; setName(e.target.value); }} maxLength={160} placeholder="Наприклад, Основний каталог" /></label>
      <details><summary>Додаткові налаштування</summary><label>Сталий ключ (латиниця, цифри, _ або -)<input className="input" disabled={Boolean(busy)} value={key} onChange={(e) => { generation.current++; setKey(e.target.value); }} pattern="[a-z][a-z0-9_-]{0,79}" /></label><p className="et-muted">Ключ підготовлено автоматично. Після створення він не змінюється.</p></details>
      {!name.trim() && <p className="et-muted">Вкажіть непорожню назву, щоб зберегти чернетку.</p>}
      <p className="et-muted">Новий шаблон використовує поточні правила перевірки джерел.</p>
      {!/^[a-z][a-z0-9_-]{0,79}$/.test(key) && <p role="alert">Ключ має починатися з малої латинської літери та містити до 80 малих латинських літер, цифр, _ або -.</p>}
      <SourceDiagnostics diagnostics={candidate?.diagnostics} definition={definition} registry={registry} canSave />
      <button className="btn btn-primary px-4" disabled={!manage || !definition || Boolean(busy) || !name.trim() || !/^[a-z][a-z0-9_-]{0,79}$/.test(key)} onClick={async () => {
        const created = await save();
        if (created?.id) navigation.commit(() => navigate(familyPath(created.id, 'fields', '')));
      }}>Створити й зберегти чернетку</button>
    </section> : <>
      <header className="et-toolbar">
        <div className="et-row"><button className="et-link" onClick={back}>← До шаблонів</button><div className="et-actions">
          {dirty && <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={discard}>Відкинути локальні зміни</button>}
          {manage && family && !selectedVersion && <button className={'btn px-4 ' + (view === 'fields' && !editing ? 'btn-primary' : 'btn-outline')} disabled={Boolean(busy)} onClick={save}>Зберегти чернетку</button>}
          {manage && selectedVersion && <button className="btn btn-primary px-3" disabled={Boolean(busy)} onClick={() => run('Копіювання в чернетку', () => api.clone(family.id, { expectedRevision: family.draft.revision, versionId }), saved)}>Створити чернетку з цієї версії</button>}
        </div></div>
        {!publishReview && !supportProposal && <Diagnostics error={error} definition={definition} registry={registry} onOpenSource={openSource} showSources={view !== 'check'} />}
        {busy && <p role="status">{busy}…</p>}{message && <p role="status" className="rounded bg-green-50 p-3">{message}</p>}
        <div className="et-title-line"><h1>{family?.display_name || 'Завантаження шаблону…'}</h1><span className="et-badge">{selectedVersion ? 'Опублікована v' + selectedVersion.versionNumber + ' · лише читання' : dirty ? 'Незбережена чернетка' : 'Чернетка'}</span>
          {family && <span className="et-muted" role="status">{selectedVersion ? 'Незмінна версія' : dirty ? 'Є незбережені зміни' : 'Збережено · ревізія ' + family.draft.revision}</span>}</div>
        {family && !selectedVersion && !validation?.valid && <p className="et-muted">Готовність до публікації не підтверджено. Збереження чернетки не перевіряє джерела та не створює експорт.</p>}
        <TemplateLocalNav familyId={route.id} versionId={versionId} />
      </header>
      {family?.id === route.id && definition && <>
        <div hidden={view !== 'fields'} className="card et-editor-surface">
          {manage && !selectedVersion && definition?.outputContract === 'magento-products-v1' && <div className="et-grid-tools"><p>Історична структура колонок. Зміна доступна лише для збереженої чернетки.</p><button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run('Оновлення контракту колонок', () => api.upgrade(family.id, precondition()), saved)}>Дозволити додавання й видалення колонок</button></div>}
          <DefinitionEditor key={family.id + '/' + versionId + '/' + editorEpoch} visible={view === 'fields' && !navigation.blocked} definition={definition} onChange={edit} onPendingChange={setPanelPending} onEditingChange={setEditing} registry={registry} loadSource={api.sourceDetails} diagnostics={sourceDiagnostics} focusField={focusField} onFieldSelect={setFieldSelection} readOnly={!manage || Boolean(selectedVersion) || (Boolean(busy) && !['Перевірка', 'Тест чернетки'].includes(busy))} />
          {!selectedVersion && <aside className="et-validation-tray" aria-label="Перевірка та тестові товари"><div><span>Перевірка: {dirty || panelPending ? 'є незбережені зміни' : issueCount ? `${issueCount} питання до публікації` : validation?.valid ? 'збережену ревізію перевірено' : 'ще не виконана'}</span><button className="et-link" onClick={() => setView('check')}>Показати</button></div>
            {manage && has('exports.view') && <div><span>Товари для тесту: {selectedSamples.length}{previewStale ? ' · застарілий результат' : preview ? ` · готові ${preview.result.readyCount}/${preview.result.representedCount}` : ''}</span><button className="et-link" onClick={() => setView('check')}>Перевірити на товарах</button></div>}
          </aside>}
        </div>
        {view === 'check' && <section className="card et-check space-y-4">
          <h2>Перевірка шаблону</h2><p>Перевірка правил та результат на збережених товарах. Ці дії не створюють експорт.</p>
          {dirty && <p role="status">Є незбережені зміни. Збережіть чернетку перед перевіркою.</p>}
          {selectedVersion ? <p>Це опублікована версія. Створіть чернетку з цієї версії для перевірки на товарах.</p> : <>
            {manage && family.draft.sourceSupportUpdate?.status === 'unsupported' && <p role="status">Не вдалося визначити сумісність цієї чернетки. Перевірте правила шаблону перед оновленням.</p>}
            {manage && family.draft.sourceSupportUpdate?.status === 'available' && <section aria-label="Оновлення правил сумісності">
              <p>Доступне оновлення правил сумісності шаблону</p>
              <p>Цю чернетку можна оновити до поточних правил перевірки джерел. Перегляньте зміни перед застосуванням.</p>
              <button className="et-link" disabled={!exactSaved} onClick={() => run('Підготовка підтримки джерел', () => api.prepareSupport(family.id, precondition()), (proposal) => {
                if (!proposal.changed) {
                  setFamily((current) => ({ ...current, draft: { ...current.draft, sourceSupportUpdate: proposal.sourceSupportUpdate } }));
                  setSupportProposal(null);
                } else setSupportProposal(proposal);
              })}>Переглянути зміни</button>
              {supportProposal && <WorkspaceDialog title="Оновлення сумісності джерел" busy={Boolean(busy)} onClose={() => setSupportProposal(null)}>
                <h2>Оновлення сумісності джерел</h2>
                <Diagnostics error={error} definition={definition} registry={registry} />
                <p>Підготовлено для ревізії {supportProposal.expectedRevision}. Чернетку ще не змінено.</p>
                <details><summary>Технічні подробиці</summary>
                <p>{supportProposal.definition?.sourceSupport?.version}</p>
                <p>NM.extra: числовий 0 дозволено як «Не обрано» лише після відтворення SKU за власною історичною схемою товару та перевірки необов’язкового питання. Рядок «0» не є сумісним placeholder.</p>
                <p>AR.size: відкладені значення залишаються в каталозі та мапінгах, але не дозволяють експорт товару. Нова SKU-схема сама їх не активує.</p>
                {Object.entries(supportProposal.changes || {}).map(([source, policy]) => <p key={source}>{source}: семантичні {policy.semanticValues.join(', ') || '—'}; відкладені {policy.deferredValues.join(', ') || '—'}.</p>)}
                </details>
                <p>Вихідні тексти не змінюються. Відсутні мапінги заповнюються окремо у формах полів. Після застосування повторіть перевірку й тест товарів.</p>
                <SourceDiagnostics diagnostics={supportProposal.diagnostics} definition={supportProposal.definition} registry={registry} />
                {!supportProposal.changed && <p role="status">Цю політику вже застосовано. Змін немає.</p>}
                <button className="btn btn-primary px-3" disabled={!exactSaved || !supportProposal.changed} onClick={() => run('Застосування підтримки джерел', () => api.applySupport(family.id, { expectedRevision: supportProposal.expectedRevision, expectedDefinitionHash: supportProposal.expectedDefinitionHash, preparationHash: supportProposal.preparationHash }), saved)}>Застосувати до чернетки</button>
                <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => setSupportProposal(null)}>Скасувати оновлення</button>
              </WorkspaceDialog>}
            </section>}
            {manage && <button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run('Перевірка', () => api.validate(family.id, precondition()), setValidation,
              (error) => setValidation({ revision: family.draft.revision, definitionHash: family.draft.definitionHash, error }))}>Перевірити шаблон</button>}
            {(validation || issueCount > 0) && <section aria-label="Повна перевірка шаблону">
              {validation?.error ? <><p>Повна перевірка · ревізія {validation.revision}</p><Diagnostics error={validation.error} showSources={false} /></>
                : validation && <p role="status">Сервер перевірив ревізію {validation.revision}.</p>}
              <SourceDiagnostics diagnostics={sourceDiagnostics} definition={definition} registry={registry} onOpenSource={openSource} showHeading={!validation?.error} />
            </section>}
            {manage && has('exports.view') && <div className="et-sample space-y-3"><h3>Переглянути результат</h3>
              <SampleProducts search={api.searchSamples} selected={selectedSamples} onChange={(products) => { generation.current++; setSampleProducts(products); setProductIds(products.map((p) => p.id).join(', ')); }} />
              <details><summary>Технічні налаштування вибірки</summary><label>ID товарів (1–100, через кому або пробіл)<input className="input" value={productIds} onChange={(e) => { generation.current++; setProductIds(e.target.value); }} /></label></details>
              <p className="et-muted">Авторитетні дані та ціни завантажить сервер.</p>
              <button className="btn btn-primary px-4" disabled={!exactSaved} onClick={() => {
                setPreview(null);
                run('Тест чернетки', () => api.preview(family.id, { ...precondition(), productIds: parseProductIds(productIds) }), (data) => setPreview({ ...data, sampleIds: parseProductIds(productIds) }));
              }}>Переглянути результат</button>
            </div>}
          </>}
          {preview ? <DraftPreview preview={preview} selectedField={fieldSelection.column} stale={previewStale} /> : <p className="et-muted">Результату ще немає. Оберіть товари й запустіть перевірку.</p>}
        </section>}
        {view === 'versions' && <section className="card et-versions space-y-4">
          <h2>Версії шаблону</h2><label>Версія<select className="input" value={versionId} disabled={Boolean(busy)} onChange={(e) => openVersion(e.target.value)}><option value="">Поточна чернетка · {family.draft.revision}</option>{family.versions.map((v) => <option key={v.id} value={v.id}>Опублікована v{v.versionNumber} · {v.publishedAt}</option>)}</select></label>
          <p>Публікація зберігає незмінну версію. Вибір для експорту виконується окремо.</p>
          {publish && !selectedVersion && <button className="btn btn-primary px-4" disabled={!exactSaved} onClick={() => { setError(null); setPublishReview(precondition()); }}>Опублікувати версію</button>}
          {publishReview && <WorkspaceDialog title="Перегляд публікації" busy={Boolean(busy)} onClose={() => setPublishReview(null)}>
            <h2>Опублікувати «{family.display_name}»</h2><p>Збережена ревізія: <strong>{publishReview.expectedRevision}</strong></p>
            <p>Результат — незмінна опублікована версія. Подальші зміни виконуються в чернетці. Вибір для експорту — окрема дія.</p>
            <p>{issueCount ? `Питання до публікації: ${issueCount}. Сервер повторно перевірить джерела.` : validation?.valid ? 'Збережена ревізія пройшла перевірку.' : 'Повну готовність ще не підтверджено. Команда публікації виконає авторитетну перевірку.'}</p>
            <details><summary>Ідентичність ревізії</summary><code>{publishReview.expectedDefinitionHash}</code></details>
            <Diagnostics error={error} definition={definition} registry={registry} />
            <div className="et-actions"><button className="btn btn-primary px-4" disabled={!publish || !exactSaved || family.draft.revision !== publishReview.expectedRevision || family.draft.definitionHash !== publishReview.expectedDefinitionHash} onClick={() => run('Публікація ревізії ' + publishReview.expectedRevision, () => api.publish(family.id, publishReview), (version) => {
            setFamily((f) => ({ ...f, versions: [...f.versions.filter((v) => v.id !== version.id), version] })); setDefinition(version.definition); clearEvidence();
            setFamilies((items) => items?.map((item) => item.id === family.id ? { ...item, publication_count: family.versions.filter((v) => v.id !== version.id).length + 1 } : item));
            setMessage('Опубліковано v' + version.versionNumber + '. Вибір для експорту не змінено.');
            setPublishReview(null);
            navigation.commit(() => navigate(familyPath(route.id, 'versions', version.id)));
          })}>Підтвердити публікацію</button><button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => setPublishReview(null)}>Скасувати</button></div>
          </WorkspaceDialog>}
          {activation && <div className="et-selection space-y-3"><h3>Вибір для експорту за шаблоном</h3><p>Застосовується лише коли експортер явно обирає експорт за шаблоном. Звичайний експорт не змінюється.</p>
            <p>{activation.implementation === 'legacy' ? 'Шаблон не вибрано' : activation.templateVersionId === selectedVersion?.id ? 'Вибрано для експорту за шаблоном · v' + selectedVersion.versionNumber : 'Вибрано іншу опубліковану версію'}</p>
            {activate && <div className="et-actions"><button className="btn btn-outline px-3" disabled={!selectedVersion || Boolean(busy)} onClick={() => run('Вибір версії', () => api.select({ expectedGeneration: activation.generation, implementation: 'template', templateVersionId: selectedVersion.id }), setActivation)}>Вибрати відкриту публікацію v{selectedVersion?.versionNumber || '—'}</button>
              <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => run('Скасування вибору', () => api.select({ expectedGeneration: activation.generation, implementation: 'legacy', templateVersionId: null }), setActivation)}>Скасувати вибір шаблону</button></div>}
            <button className="et-link" disabled={Boolean(busy)} onClick={() => run('Оновлення вибору', () => api.activation(), setActivation)}>Оновити стан вибору</button>
          </div>}
          <details><summary>Додаткові налаштування</summary><p>Сталий ключ: {family.template_key}</p><p className="break-all">{family.id} · {selectedVersion?.definitionHash || family.draft.definitionHash}</p></details>
        </section>}
      </>}
    </>}
  </TemplateWorkspaceShell>;
}

export default function ExportTemplatesPage() {
  const { permissions, applicationUser } = useAuth();
  if (!permissions.includes('export_templates.view')) return <main className="app-page p-6"><h1>Немає дозволу на перегляд шаблонів експорту</h1></main>;
  return <TemplateWorkspace key={applicationUser?.id || 'isolated'} permissions={permissions} />;
}
