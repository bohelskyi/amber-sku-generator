import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/auth-context';
import { exportTemplatesApi as api } from '../api/export-templates-api';
import { DefinitionEditor } from '../components/export-templates/DefinitionEditor';
import { parseProductIds } from '../lib/export-template-editor';
import { getApiError } from '../lib/http-error';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation';
import { SourceDiagnostics } from '../components/export-templates/SourceDiagnostics';
import { SampleProducts } from '../components/export-templates/SampleProducts';
import { PreviewTable } from '../components/export-templates/PreviewTable';
import { fieldsForSource } from '../lib/export-template-attributes';

function Diagnostics({ error, definition, registry, onOpenSource }) {
  if (!error) return null;
  const data = error.response?.data;
  return <div role="alert" className="danger-panel p-3 space-y-2">
    <p>{data?.code === 'TEMPLATE_DRAFT_CONFLICT'
      ? 'На сервері вже новіша чернетка. Ваші локальні зміни збережено у формі. Автоматичного перезапису немає.'
      : data?.code === 'TEMPLATE_KEY_CONFLICT' ? 'Ключ уже зайнятий. Перевірте список шаблонів або змініть ключ у додаткових налаштуваннях.'
        : data?.code === 'TEMPLATE_SOURCE_INVALID' ? 'Шаблон не готовий до публікації: джерела потребують перевірки.'
          : data?.code === 'TEMPLATE_INVALID' ? 'Помилка структури або безпеки визначення. Перевірте правила; ваші локальні зміни залишилися у формі.' : getApiError(error)}</p>
    {data?.code && <p className="text-xs">{data.code}</p>}
    <SourceDiagnostics diagnostics={data?.details?.diagnostics} definition={definition} registry={registry} onOpenSource={onOpenSource} />
    {data?.code === 'TEMPLATE_INVALID' && <details><summary>Технічні подробиці</summary>{getApiError(error)}</details>}
    {data?.details?.missingProductIds && <p>Не знайдено ID: {data.details.missingProductIds.join(', ')}. Жоден ID не пропущено.</p>}
  </div>;
}

function DraftPreview({ preview, stale, definition, registry, onOpenSource, selectedField }) {
  const result = preview.result;
  return <section className="rounded border border-blue-300 bg-blue-50 p-4 space-y-3" aria-label="Тест чернетки">
    <h2 className="font-semibold">Результат перевірки · ревізія {preview.revision}</h2>
    <p>Товари: {preview.sampleIds?.join(', ')}. {stale ? 'Застарілий результат — збережіть зміни та повторіть перевірку.' : 'Результат збереженої ревізії. Експорт не створено.'}</p>
    {preview.sampleProducts?.map((product) => <p key={product.productId}>{product.productId} · {product.category} · {product.sku}</p>)}
    {preview.globalSourceDiagnostics?.length > 0 && <>
      <p>{stale ? 'Для перевіреної ревізії:' : 'Результат показано для вибраних товарів.'} У шаблоні залишилися проблеми інших категорій; публікація заблокована.</p>
      <SourceDiagnostics diagnostics={preview.globalSourceDiagnostics} definition={definition} registry={registry} onOpenSource={onOpenSource} />
    </>}
    <p>Представлено: {result.representedCount}; готові: {result.readyCount}</p>
    {result.errors?.length > 0 && <p>Значення товарів не готові до експорту. Це окрема перевірка від підтвердження джерел шаблону.</p>}
    {(result.errors || []).map((p, i) => <div key={i} className="text-red-800">{p.sku}: {(p.fields || []).map((f) => `${f.field}: ${f.message}`).join('; ')}</div>)}
    {(result.provisionalArtifacts || result.artifacts || []).map((a) => <div key={a.groupCode}><PreviewTable key={a.groupCode + '/' + selectedField} artifact={a} selectedField={selectedField} />
      <details><summary>CSV / технічний перегляд</summary><pre className="max-h-80 overflow-auto whitespace-pre text-xs">{a.csvContent}</pre></details></div>)}
  </section>;
}

function TemplateWorkspace({ permissions }) {
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
  const [versionId, setVersionId] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [validation, setValidation] = useState(null);
  const [preview, setPreview] = useState(null);
  const [productIds, setProductIds] = useState('');
  const [sampleProducts, setSampleProducts] = useState([]);
  const [fieldSelection, setFieldSelection] = useState({ groupIndex: 0, rowIndex: 0, column: 'name' });
  const [focusField, setFocusField] = useState(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [view, setView] = useState('fields');
  const [screen, setScreen] = useState('list');
  const [system, setSystem] = useState(null);
  const generation = useRef(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  const permissionKey = permissions.join('|');
  const openSource = (sourceId) => {
    const fields = fieldsForSource(definition, sourceId);
    const target = fields.find((f) => f.groupIndex === fieldSelection.groupIndex && f.rowIndex === fieldSelection.rowIndex) || fields[0];
    if (target) { setFocusField({ ...target, sourceId }); setView('fields'); }
  };
  const sourceDiagnostics = [...(validation?.error?.response?.data?.details?.diagnostics || []), ...(error?.response?.data?.details?.diagnostics || []), ...(preview?.globalSourceDiagnostics || [])];
  let selectedSamples = [];
  try { selectedSamples = parseProductIds(productIds).map((id) => sampleProducts.find((p) => p.id === id) || { id }); } catch { /* Invalid technical input remains visible and is rejected on submit. */ }

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

  const clearEvidence = () => { setValidation(null); setPreview(null); setMessage(''); };
  const edit = (next) => { generation.current++; setDefinition(next); setDirty(true); setValidation(null); setMessage(''); };
  async function run(label, task, apply, onError) {
    if (operation.current) return;
    if (!document.getElementById('template-definition-form')?.reportValidity() && document.getElementById('template-definition-form')) return;
    operation.current = true;
    const ticket = generation.current;
    setBusy(label); setError(null); setMessage('');
    try {
      const result = await task();
      if (mounted.current && ticket === generation.current) { apply(result.data); return true; }
    } catch (e) { if (mounted.current && ticket === generation.current) { if (onError) onError(e); else setError(e); } }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  // Loads may complete out of order; only the latest selected family may apply.
  async function load(id) {
    const ticket = ++generation.current;
    setFamily(null); setDefinition(null); setCandidate(null); setError(null); clearEvidence(); setBusy('Завантаження'); setScreen('editor'); setView('fields'); setDirty(false);
    try {
      const response = await api.get(id);
      if (ticket !== generation.current || !mounted.current) return;
      setFamily(response.data); setDefinition(response.data.draft.definition); setVersionId('');
    } catch (e) { if (ticket === generation.current && mounted.current) setError(e); }
    finally { if (ticket === generation.current && mounted.current) setBusy(''); }
  }
  const precondition = () => ({ expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash });
  const saved = (draft) => {
    setFamily((f) => ({ ...f, draft })); setDefinition(draft.definition); setDirty(false); setVersionId(''); clearEvidence();
    setFamilies((items) => items?.map((item) => item.id === family.id ? { ...item, draft_revision: draft.revision } : item));
  };
  const selectedVersion = family?.versions?.find((v) => v.id === versionId);
  const exactSaved = family && !dirty && !versionId && !busy;
  const discard = () => {
    generation.current++; setDirty(false); clearEvidence(); setError(null);
    if (family) setDefinition(family.draft.definition); else { setCandidate(null); setDefinition(null); setScreen('list'); }
  };
  const save = () => {
    if (!manage || versionId) return false;
    if (family) return run('Збереження', () => api.save(family.id, { expectedRevision: family.draft.revision, definition }), saved);
    if (!name.trim() || !/^[a-z][a-z0-9_-]{0,79}$/.test(key)) { setError(new Error('Вкажіть назву та сталий ключ шаблону перед збереженням.')); return false; }
    return run('Створення чернетки', () => api.create({ key, displayName: name, definition }), (data) => {
      setFamily({ ...data, versions: [] }); setDefinition(data.draft.definition); setCandidate(null); setDirty(false); setScreen('editor'); setView('fields');
      setFamilies((items) => [...(items || []), { ...data, draft_revision: data.draft.revision, publication_count: 0 }]);
    });
  };
  const navigation = useDirtyNavigation({ dirty, save: manage ? save : null, discard, busy: Boolean(busy) });
  const openVersion = (id) => navigation.request(() => {
    generation.current++; setVersionId(id); clearEvidence();
    setDefinition(id ? family.versions.find((v) => v.id === id).definition : family.draft.definition);
  });
  const back = () => navigation.request(() => {
    generation.current++; setScreen('list'); setFamily(null); setCandidate(null); setDefinition(null); setDirty(false); clearEvidence(); setError(null);
  });
  return <main className="app-page et-workspace"><div className="et-page">
    {navigation.prompt}
    {screen !== 'editor' && <><Diagnostics error={error} definition={definition} registry={registry} />{busy && <p role="status">{busy}…</p>}</>}
    {screen === 'list' ? <>
      <header className="et-page-heading"><div><p className="et-eyebrow">Magento</p><h1>Шаблони експорту</h1><p className="et-muted">Налаштуйте назви, характеристики та порядок полів у файлі.</p></div>
        {manage && <button className="btn btn-primary px-4" disabled={Boolean(busy)} onClick={() => run('Підготовка шаблону', () => api.candidate(), (data) => {
          generation.current++; setFamily(null); setVersionId(''); setCandidate(data); setDefinition(data.definition); setName('');
          setKey('template-' + crypto.randomUUID()); setDirty(true); clearEvidence(); setScreen('create');
        })}>Створити шаблон</button>}
      </header>
      <section className="card et-template-list" aria-label="Шаблони">
        <article className="et-template-row"><div><h2>Magento — поточний системний</h2><p className="et-muted">Звичайний експорт · правила з коду · не опублікований шаблон</p></div>
          <button className="btn btn-outline px-4" disabled={Boolean(busy)} onClick={() => run('Відкриття системного профілю', () => api.system(), (data) => { setSystem(data); setScreen('system'); })}>Відкрити системний профіль</button></article>
        <button className="et-link" disabled={Boolean(busy)} onClick={() => run('Оновлення списку', () => api.list(), (data) => setFamilies(data.templates))}>Оновити список</button>
        {families === null ? <p>{error ? 'Не вдалося завантажити шаблони. Спробуйте оновити список.' : 'Завантаження шаблонів…'}</p> : !families.length ? <div className="et-empty"><h2>Шаблонів ще немає</h2><p>Створіть перший шаблон на основі готових правил Magento.</p></div>
          : families.map((item) => <article className="et-template-row" key={item.id}><div><h2>{item.display_name}</h2><p className="et-muted">Чернетка {item.draft_revision || item.draft?.revision} · Опублікованих версій: {item.publication_count ?? item.versions?.length ?? 0}</p></div><button className="btn btn-outline px-4" onClick={() => load(item.id)} aria-label={'Відкрити ' + item.display_name}>Відкрити</button></article>)}
      </section>
    </> : screen === 'system' ? <section className="card et-editor-surface">
      <button className="et-link" onClick={back}>← До шаблонів</button><h1>Magento — поточний системний</h1>
      <p>Системні правила застосунку та шість CSV-таблиць звичайного експорту. Профіль доступний лише для перегляду; для змін створіть власну чернетку.</p>
      {manage && <button className="btn btn-primary px-4" onClick={() => { setCandidate(system); setDefinition(system.definition); setFamily(null); setVersionId(''); setName(''); setKey('template-' + crypto.randomUUID()); setDirty(true); setScreen('create'); }}>Створити редаговану копію</button>}
      <DefinitionEditor definition={system.definition} readOnly registry={registry} />
    </section> : screen === 'create' ? <section className="card et-create">
      <button className="et-link" onClick={back}>← До шаблонів</button><h1>Новий шаблон</h1><p className="et-muted">Незбережена чернетка на основі Magento. Вкажіть назву, щоб створити її.</p>
      <label>Назва шаблону<input autoFocus className="input" disabled={Boolean(busy)} value={name} onChange={(e) => { generation.current++; setName(e.target.value); }} maxLength={160} placeholder="Наприклад, Основний каталог" /></label>
      <details><summary>Додаткові налаштування</summary><label>Сталий ключ (латиниця, цифри, _ або -)<input className="input" disabled={Boolean(busy)} value={key} onChange={(e) => { generation.current++; setKey(e.target.value); }} pattern="[a-z][a-z0-9_-]{0,79}" /></label><p className="et-muted">Ключ підготовлено автоматично. Після створення він не змінюється.</p></details>
      {!name.trim() && <p className="et-muted">Вкажіть непорожню назву, щоб зберегти чернетку.</p>}
      {!/^[a-z][a-z0-9_-]{0,79}$/.test(key) && <p role="alert">Ключ має починатися з малої латинської літери та містити до 80 малих латинських літер, цифр, _ або -.</p>}
      <SourceDiagnostics diagnostics={candidate?.diagnostics} definition={definition} registry={registry} canSave />
      <button className="btn btn-primary px-4" disabled={Boolean(busy) || !name.trim() || !/^[a-z][a-z0-9_-]{0,79}$/.test(key)} onClick={save}>Створити й зберегти чернетку</button>
    </section> : <>
      <header className="et-toolbar">
        <div className="et-row"><button className="et-link" onClick={back}>← До шаблонів</button><div className="et-actions">
          {dirty && <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={discard}>Відкинути локальні зміни</button>}
          {manage && family && !selectedVersion && <button className="btn btn-primary px-4" disabled={Boolean(busy)} onClick={save}>Зберегти чернетку</button>}
          {manage && selectedVersion && <button className="btn btn-primary px-3" disabled={Boolean(busy)} onClick={() => run('Копіювання в чернетку', () => api.clone(family.id, { expectedRevision: family.draft.revision, versionId }), saved)}>Створити чернетку з цієї версії</button>}
        </div></div>
        <Diagnostics error={error} definition={definition} registry={registry} onOpenSource={openSource} />
        {busy && <p role="status">{busy}…</p>}{message && <p role="status" className="rounded bg-green-50 p-3">{message}</p>}
        <div className="et-title-line"><h1>{family?.display_name || 'Завантаження шаблону…'}</h1><span className="et-badge">{selectedVersion ? 'Опублікована v' + selectedVersion.versionNumber + ' · лише читання' : dirty ? 'Незбережена чернетка' : 'Чернетка'}</span>
          {family && <span className="et-muted" role="status">{selectedVersion ? 'Незмінна версія' : dirty ? 'Є незбережені зміни' : 'Збережено · ревізія ' + family.draft.revision}</span>}</div>
        {family && !selectedVersion && !validation?.valid && <p className="et-muted">Готовність до публікації не підтверджено. Збереження чернетки не перевіряє джерела та не створює експорт.</p>}
        <nav className="et-tabs" aria-label="Розділи шаблону">{[['fields', 'Поля експорту'], ['check', 'Перевірка'], ['versions', 'Версії']].map(([id, title]) => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{title}</button>)}</nav>
      </header>
      {family && <>
        <div hidden={view !== 'fields'} className="card et-editor-surface">
          {manage && !selectedVersion && definition?.outputContract === 'magento-products-v1' && <div className="et-grid-tools"><p>Історичний фіксований v1. Оновлення збереже правила, локальні зміни та порожні EN-клітинки.</p><button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run('Оновлення контракту колонок', () => api.upgrade(family.id, precondition()), saved)}>Увімкнути редагування колонок · v2</button></div>}
          <DefinitionEditor key={family.id + '/' + versionId} definition={definition} onChange={edit} registry={registry} loadSource={api.sourceDetails} diagnostics={sourceDiagnostics} focusField={focusField} onFieldSelect={setFieldSelection} readOnly={!manage || Boolean(selectedVersion) || (Boolean(busy) && !['Перевірка', 'Тест чернетки'].includes(busy))} />
          <aside className="et-result-hint"><div><h3>Результат на товарі</h3><p>{dirty ? 'Збережіть зміни, щоб отримати актуальний результат.' : preview ? 'Останній тест: ревізія ' + preview.revision + ', товари ' + preview.sampleIds?.join(', ') + '.' : 'Перевірте збережену чернетку на ID наявних товарів.'}</p></div><button className="btn btn-outline px-3" onClick={() => setView('check')}>Перейти до перевірки</button></aside>
        </div>
        {view === 'check' && <section className="card et-check space-y-4">
          <h2>Перевірка шаблону</h2><p>Перевірка правил та результат на збережених товарах. Ці дії не створюють експорт.</p>
          {dirty && <p role="status">Є незбережені зміни. Збережіть чернетку перед перевіркою.</p>}
          {selectedVersion ? <p>Це опублікована версія. Створіть чернетку з цієї версії для перевірки на товарах.</p> : <>
            {manage && <button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run('Перевірка', () => api.validate(family.id, precondition()), setValidation,
              (error) => setValidation({ revision: family.draft.revision, definitionHash: family.draft.definitionHash, error }))}>Перевірити шаблон</button>}
            {validation && <section aria-label="Повна перевірка шаблону">
              {validation.error ? <><p>Повна перевірка · ревізія {validation.revision}</p><Diagnostics error={validation.error} definition={definition} registry={registry} onOpenSource={openSource} /></>
                : <p role="status">Сервер перевірив ревізію {validation.revision}.</p>}
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
          {preview ? <DraftPreview preview={preview} definition={definition} registry={registry} onOpenSource={openSource} selectedField={fieldSelection.column} stale={dirty || preview.revision !== family.draft.revision || preview.sampleIds?.join(',') !== productIds.trim().split(/[\s,;]+/).map(Number).join(',')} /> : <p className="et-muted">Результату ще немає. Оберіть товари й запустіть перевірку.</p>}
        </section>}
        {view === 'versions' && <section className="card et-versions space-y-4">
          <h2>Версії шаблону</h2><label>Версія<select className="input" value={versionId} disabled={Boolean(busy)} onChange={(e) => openVersion(e.target.value)}><option value="">Поточна чернетка · {family.draft.revision}</option>{family.versions.map((v) => <option key={v.id} value={v.id}>Опублікована v{v.versionNumber} · {v.publishedAt}</option>)}</select></label>
          <p>Публікація зберігає незмінну версію. Вибір для експорту виконується окремо.</p>
          {publish && !selectedVersion && <button className="btn btn-primary px-4" disabled={!exactSaved} onClick={() => run('Публікація ревізії ' + family.draft.revision, () => api.publish(family.id, precondition()), (version) => {
            setFamily((f) => ({ ...f, versions: [...f.versions.filter((v) => v.id !== version.id), version] })); setVersionId(version.id); setDefinition(version.definition); clearEvidence();
            setFamilies((items) => items?.map((item) => item.id === family.id ? { ...item, publication_count: family.versions.filter((v) => v.id !== version.id).length + 1 } : item));
            setMessage('Опубліковано v' + version.versionNumber + '. Вибір для експорту не змінено.');
          })}>Опублікувати версію</button>}
          {activation && <div className="et-selection space-y-3"><h3>Вибір для експорту за шаблоном</h3><p>Застосовується лише коли експортер явно обирає експорт за шаблоном. Звичайний експорт не змінюється.</p>
            <p>{activation.implementation === 'legacy' ? 'Шаблон не вибрано' : activation.templateVersionId === selectedVersion?.id ? 'Вибрано відкриту версію v' + selectedVersion.versionNumber : 'Вибрано іншу опубліковану версію'}</p>
            {activate && <div className="et-actions"><button className="btn btn-outline px-3" disabled={!selectedVersion || Boolean(busy)} onClick={() => run('Вибір версії', () => api.select({ expectedGeneration: activation.generation, implementation: 'template', templateVersionId: selectedVersion.id }), setActivation)}>Вибрати відкриту публікацію v{selectedVersion?.versionNumber || '—'}</button>
              <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => run('Скасування вибору', () => api.select({ expectedGeneration: activation.generation, implementation: 'legacy', templateVersionId: null }), setActivation)}>Скасувати вибір шаблону</button></div>}
            <button className="et-link" disabled={Boolean(busy)} onClick={() => run('Оновлення вибору', () => api.activation(), setActivation)}>Оновити стан вибору</button>
          </div>}
          <details><summary>Додаткові налаштування</summary><p>Сталий ключ: {family.template_key}</p><p className="break-all">{family.id} · {selectedVersion?.definitionHash || family.draft.definitionHash}</p></details>
        </section>}
      </>}
    </>}
  </div></main>;
}

export default function ExportTemplatesPage() {
  const { permissions, applicationUser } = useAuth();
  if (!permissions.includes('export_templates.view')) return <main className="app-page p-6"><h1>Немає дозволу на перегляд шаблонів експорту</h1></main>;
  return <TemplateWorkspace key={applicationUser?.id || 'isolated'} permissions={permissions} />;
}
