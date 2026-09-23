import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/auth-context';
import { exportTemplatesApi as api } from '../api/export-templates-api';
import { DefinitionEditor } from '../components/export-templates/DefinitionEditor';
import { parseProductIds } from '../lib/export-template-editor';
import { getApiError } from '../lib/http-error';
import { useDirtyNavigation } from '../hooks/useDirtyNavigation';

function Diagnostics({ error }) {
  if (!error) return null;
  const data = error.response?.data;
  return <div role="alert" className="danger-panel p-3 space-y-2">
    <p>{data?.code === 'TEMPLATE_DRAFT_CONFLICT'
      ? 'На сервері вже новіша чернетка. Ваші локальні зміни збережено у формі. Автоматичного перезапису немає.' : getApiError(error)}</p>
    {data?.code && <p className="text-xs">{data.code}</p>}
    {(data?.details?.diagnostics || []).map((d, i) => <p key={i}>{d.sourceId}: {d.message} ({d.code})</p>)}
    {data?.details?.missingProductIds && <p>Не знайдено ID: {data.details.missingProductIds.join(', ')}. Жоден ID не пропущено.</p>}
  </div>;
}

function DraftPreview({ preview }) {
  const result = preview.result;
  return <section className="rounded border border-blue-300 bg-blue-50 p-4 space-y-3" aria-label="Тест чернетки">
    <h2 className="font-semibold">Тест чернетки — лише читання · ревізія {preview.revision}</h2>
    <p>Не створює файлів знімка, не змінює чергу чи експозицію. Не є дозволом на експорт.</p>
    <p>Представлено: {result.representedCount}; готові: {result.readyCount}</p>
    {(result.errors || []).map((p, i) => <div key={i} className="text-red-800">{p.sku}: {(p.fields || []).map((f) => `${f.field}: ${f.message}`).join('; ')}</div>)}
    {(result.artifacts || []).map((a) => <details key={a.groupCode}><summary>{a.groupName} · {a.rowCount} рядків</summary>
      <pre className="max-h-80 overflow-auto whitespace-pre text-xs">{a.csvContent}</pre></details>)}
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
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const operation = useRef(false);
  const mounted = useRef(true);
  const permissionKey = permissions.join('|');

  useEffect(() => {
    generation.current++;
  }, [permissionKey]);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    Promise.all([api.list(), api.sources(), api.activation()]).then(([list, sources, selection]) => {
      if (!current) return;
      setFamilies(list.data.templates); setRegistry(sources.data); setActivation(selection.data);
    }).catch((e) => { if (current) setError(e); });
    return () => { current = false; mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const clearEvidence = () => { setValidation(null); setPreview(null); setMessage(''); };
  const edit = (next) => { generation.current++; setDefinition(next); setDirty(true); clearEvidence(); };
  async function run(label, task, apply) {
    if (operation.current) return;
    if (!document.getElementById('template-definition-form')?.reportValidity() && document.getElementById('template-definition-form')) return;
    operation.current = true;
    const ticket = generation.current;
    setBusy(label); setError(null); setMessage('');
    try {
      const result = await task();
      if (mounted.current && ticket === generation.current) { apply(result.data); return true; }
    } catch (e) { if (mounted.current && ticket === generation.current) setError(e); }
    finally { operation.current = false; if (mounted.current) setBusy(''); }
  }
  // Loads may complete out of order; only the latest selected family may apply.
  async function load(id) {
    const ticket = ++generation.current;
    setFamily(null); setDefinition(null); setCandidate(null); setError(null); clearEvidence(); setBusy('Завантаження');
    try {
      const response = await api.get(id);
      if (ticket !== generation.current || !mounted.current) return;
      setFamily(response.data); setDefinition(response.data.draft.definition); setVersionId('');
    } catch (e) { if (ticket === generation.current && mounted.current) setError(e); }
    finally { if (ticket === generation.current && mounted.current) setBusy(''); }
  }
  const precondition = () => ({ expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash });
  const saved = (draft) => { setFamily((f) => ({ ...f, draft })); setDefinition(draft.definition); setDirty(false); setVersionId(''); clearEvidence(); };
  const selectedVersion = family?.versions?.find((v) => v.id === versionId);
  const exactSaved = family && !dirty && !versionId && !busy;
  const discard = () => {
    generation.current++; setDirty(false); clearEvidence(); setError(null);
    if (family) setDefinition(family.draft.definition); else { setCandidate(null); setDefinition(null); }
  };
  const save = () => {
    if (!manage || versionId) return false;
    if (family) return run('Збереження', () => api.save(family.id, { expectedRevision: family.draft.revision, definition }), saved);
    if (!name.trim() || !/^[a-z][a-z0-9_-]{0,79}$/.test(key)) { setError(new Error('Вкажіть назву та сталий ключ шаблону перед збереженням.')); return false; }
    return run('Створення чернетки', () => api.create({ key, displayName: name, definition }), (data) => {
      setFamily({ ...data, versions: [] }); setDefinition(data.draft.definition); setCandidate(null); setDirty(false);
      setFamilies((items) => [...(items || []), { ...data, draft_revision: data.draft.revision, publication_count: 0 }]);
    });
  };
  const navigation = useDirtyNavigation({ dirty, save: manage ? save : null, discard, busy: Boolean(busy) });
  return <main className="app-page"><div className="mx-auto max-w-6xl p-4 sm:p-6 space-y-5">
    {navigation.prompt}
    <h1 className="text-2xl font-semibold">Шаблони експорту Magento</h1>
    <p>Редаговані кандидати із зафіксованими правилами. Збереження, публікація та вибір не підтверджують production acceptance і самі не створюють експорт.</p>
    <Diagnostics error={error} />
    {busy && <p role="status">{busy}…</p>}{message && <p role="status" className="rounded bg-green-50 p-3">{message}</p>}
    <section className="card p-4 space-y-3">
      <h2 className="font-semibold">Реєстр шаблонів</h2>
      {families === null ? <p>Завантаження реєстру…</p> : !families.length ? <p>Шаблонів ще немає. Підготуйте перший кандидат на основі Magento v1.</p> :
        <label>Шаблон<select className="input" value={family?.id || ''} disabled={Boolean(busy)} onChange={(e) => { const id = e.target.value; if (id) navigation.request(() => load(id)); }}>
          <option value="">Оберіть шаблон</option>{families.map((f) => <option key={f.id} value={f.id}>{f.display_name} · чернетка {f.draft_revision} · публікацій {f.publication_count}</option>)}
        </select></label>}
      {manage && <button className="btn btn-outline px-3" disabled={Boolean(busy) || dirty} onClick={() => run('Підготовка кандидата', () => api.candidate(), (data) => {
        generation.current++; setFamily(null); setVersionId(''); setCandidate(data); setDefinition(data.definition); setDirty(true); clearEvidence();
      })}>Створити шаблон на основі Magento v1</button>}
    </section>
    {candidate && <section className="card p-4 space-y-3">
      <h2 className="font-semibold">Новий кандидат — ще не збережено</h2>
      <p>Required/visibility та ID зафіксовані з каталогу на момент підготовки. Це редагований кандидат, а не автоматично затверджений шаблон.</p>
      {candidate.diagnostics?.length > 0 && <div role="alert" className="danger-panel p-3"><p>Каталог не підтверджує повний кандидат. Публікація потребує усунення джерельних проблем.</p>
        {candidate.diagnostics.map((d, i) => <p key={i}>{d.sourceId}: {d.message} ({d.code})</p>)}</div>}
      <label className="block">Назва шаблону<input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} /></label>
      <label className="block">Сталий ключ (латиниця, цифри, _ або -)<input className="input" value={key} onChange={(e) => setKey(e.target.value)} pattern="[a-z][a-z0-9_-]{0,79}" /></label>
      {manage && <button className="btn btn-primary px-3" disabled={Boolean(busy) || !name.trim() || !/^[a-z][a-z0-9_-]{0,79}$/.test(key)} onClick={() => run('Створення чернетки', () => api.create({ key, displayName: name, definition }), (data) => {
        setFamily({ ...data, versions: [] }); setDefinition(data.draft.definition); setCandidate(null); setDirty(false);
        setFamilies((items) => [...(items || []), { ...data, draft_revision: data.draft.revision, publication_count: 0 }]);
      })}>Створити й зберегти чернетку</button>}
    </section>}
    {family && <section className="card p-4 space-y-3">
      <h2 className="text-xl font-semibold break-words">{family.display_name} · {selectedVersion ? `Опублікована v${selectedVersion.versionNumber}` : `Чернетка · ревізія ${family.draft.revision}`}</h2>
      <label>Версія<select className="input" value={versionId} disabled={Boolean(busy)} onChange={(e) => {
        const id = e.target.value;
        navigation.request(() => {
          generation.current++; setVersionId(id); clearEvidence();
          setDefinition(id ? family.versions.find((v) => v.id === id).definition : family.draft.definition);
        });
      }}><option value="">Поточна чернетка · {family.draft.revision}</option>{family.versions.map((v) => <option key={v.id} value={v.id}>Опублікована v{v.versionNumber} · {v.publishedAt}</option>)}</select></label>
      {selectedVersion && <p>Незмінна публікація. Для подальших змін скопіюйте її в чернетку.</p>}
      <div className="flex flex-wrap gap-3">
        {manage && !selectedVersion && <button className="btn btn-primary px-3" disabled={Boolean(busy)} onClick={() => run('Збереження', () => api.save(family.id, { expectedRevision: family.draft.revision, definition }), saved)}>Зберегти чернетку</button>}
        {manage && selectedVersion && <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => run('Копіювання в чернетку', () => api.clone(family.id, { expectedRevision: family.draft.revision, versionId }), saved)}>Копіювати публікацію в чернетку</button>}
        {manage && !selectedVersion && <button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run('Перевірка', () => api.validate(family.id, precondition()), setValidation)}>Перевірити збережену ревізію</button>}
        {publish && !selectedVersion && <button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run(`Публікація ревізії ${family.draft.revision}`, () => api.publish(family.id, precondition()), (version) => {
          setFamily((f) => ({ ...f, versions: [...f.versions.filter((v) => v.id !== version.id), version] }));
          setVersionId(version.id); setDefinition(version.definition); clearEvidence(); setMessage(`Опубліковано v${version.versionNumber}, ревізія ${version.sourceDraftRevision}. Вибір не змінено.`);
        })}>Опублікувати ревізію {family.draft.revision}</button>}
      </div>
      {validation && <p role="status">Сервер перевірив ревізію {validation.revision}. Перевірка не є виробничим прийманням.</p>}
      <details><summary>Ідентифікатори та хеш</summary><p className="break-all text-xs">{family.id} · {selectedVersion?.id || 'чернетка'} · {selectedVersion?.definitionHash || family.draft.definitionHash}</p></details>
      {manage && has('exports.view') && !selectedVersion && <div className="rounded border border-blue-300 p-3 space-y-2">
        <h3 className="font-semibold">Тест чернетки без експорту</h3><label className="block">ID товарів (1–100, через кому або пробіл)<input className="input" value={productIds} onChange={(e) => { generation.current++; setProductIds(e.target.value); setPreview(null); }} /></label>
        <p className="text-xs">Лише ID вже збережених товарів. Товари та ціни завантажує сервер. Пошук каталогу не виконується.</p>
        <button className="btn btn-outline px-3" disabled={!exactSaved} onClick={() => run('Тест чернетки', () => api.preview(family.id, { ...precondition(), productIds: parseProductIds(productIds) }), setPreview)}>Переглянути тестовий результат</button>
      </div>}
    </section>}
    {definition && <section className="card p-4 space-y-3">
      <p role="status">{dirty ? 'Локальні незбережені зміни. Попередня перевірка й тест більше не чинні.' : selectedVersion ? 'Лише читання: публікація' : 'Збережена серверна чернетка'}</p>
      {dirty && <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => {
        generation.current++; setDirty(false); clearEvidence(); setError(null);
        if (family) setDefinition(family.draft.definition); else { setCandidate(null); setDefinition(null); }
      }}>Відкинути локальні зміни</button>}
      <DefinitionEditor definition={definition} onChange={edit} registry={registry} readOnly={!manage || Boolean(selectedVersion) || (Boolean(busy) && !['Перевірка', 'Тест чернетки'].includes(busy))} />
    </section>}
    {preview && <DraftPreview preview={preview} />}
    {activation && <section className="card p-4 space-y-3">
      <h2 className="font-semibold">Вибір кандидата для контрольованого експорту</h2>
      <p>Цей вибір застосовується лише після явного ввімкнення шаблонного режиму експортером. Звичайний експорт залишається legacy. Це не глобальний rollout.</p>
      <p>Покоління {activation.generation} · {activation.implementation === 'legacy' ? 'шаблон не вибрано' : `вибрана публікація ${activation.templateVersionId}`}</p>
      {activate && <div className="flex flex-wrap gap-3">
        <button className="btn btn-outline px-3" disabled={!selectedVersion || Boolean(busy)} onClick={() => run('Вибір кандидата', () => api.select({ expectedGeneration: activation.generation, implementation: 'template', templateVersionId: selectedVersion.id }), setActivation)}>Вибрати відкриту публікацію v{selectedVersion?.versionNumber || '—'}</button>
        <button className="btn btn-outline px-3" disabled={Boolean(busy)} onClick={() => run('Скасування вибору', () => api.select({ expectedGeneration: activation.generation, implementation: 'legacy', templateVersionId: null }), setActivation)}>Скасувати вибір шаблону</button>
      </div>}
      <button className="underline" disabled={Boolean(busy)} onClick={() => run('Оновлення покоління', () => api.activation(), setActivation)}>Оновити стан вибору</button>
    </section>}
  </div></main>;
}

export default function ExportTemplatesPage() {
  const { permissions, applicationUser } = useAuth();
  if (!permissions.includes('export_templates.view')) return <main className="app-page p-6"><h1>Немає дозволу на перегляд шаблонів експорту</h1></main>;
  return <TemplateWorkspace key={applicationUser?.id || 'isolated'} permissions={permissions} />;
}
