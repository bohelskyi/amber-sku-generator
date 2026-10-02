import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoBindingReview from './MagentoBindingReview.jsx';
import MagentoCategoryActions from './MagentoCategoryActions.jsx';
import MagentoOptionActions from './MagentoOptionActions.jsx';
import MagentoPublicationActions from './MagentoPublicationActions.jsx';
import MagentoProductChecks from './MagentoProductChecks.jsx';

const stages = ['Що змінюємо?', 'Ресурси Magento', 'Відповідності', 'Перевірка товарів', 'Публікація'];
export default function MagentoPreparationWorkspace({ activePublication, observation, onPublished, onDiscover, checking }) {
  const { permissions } = useAuth(); const [params] = useSearchParams();
  const [revisionId, setRevisionId] = useState(''); const [categoryCode, setCategoryCode] = useState(params.get('category') || '');
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const [stage, setStage] = useState(0); const [intent, setIntent] = useState(''); const [representatives, setRepresentatives] = useState([]);
  const [draftsNeedingObservation, setDraftsNeedingObservation] = useState(() => new Set()); const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const ticket = ++sequence.current;
    api.get('/admin/magento-integration', { params: revisionId ? { bindingRevisionId: revisionId } : {}, signal: controller.signal })
      .then(({ data: result }) => { if (!controller.signal.aborted && ticket === sequence.current) { setData(result); setError(''); } })
      .catch((cause) => { if (!controller.signal.aborted && ticket === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати контекст підготовки.'); });
    return () => { controller.abort(); };
  }, [revisionId, activePublication?.id, reload]);
  function changeRevision(revision) {
    ++sequence.current; setData(null); setRepresentatives([]); setRevisionId(revision.id); setReload((value) => value + 1); setError('');
  }
  const revision = data?.revision;
  const resourcesChanged = draftsNeedingObservation.has(revision?.id);
  const category = data?.categories.find((item) => item.code === categoryCode) || data?.categories[0];
  const activeRevision = activePublication ? { ...activePublication, state: 'published' } : null;
  const canPreview = permissions.includes('export_templates.manage') && permissions.includes('exports.view');
  const sourceChanged = data && data.currentPublishedId !== (activePublication?.id || null);
  const currentRepresentatives = representatives.filter((item) => item.bindingId === revision?.id
    && item.bindingRevision === revision?.revision && item.publicationId === activePublication?.id);
  const resourceChanged = () => {
    // Every already-frozen draft retains its old observation, even after another
    // draft is selected or a fresh successor is prepared in this workspace.
    setDraftsNeedingObservation((previous) => new Set([...previous, revision.id,
      ...data.revisions.filter((item) => item.state === 'draft').map((item) => item.id)]));
    setRepresentatives([]);
  };
  const successorChanged = (next) => { changeRevision(next); };
  return <div className="space-y-5">
    <h2 className="text-xl font-semibold">Підготувати зміни інтеграції</h2>
    <p className="text-sm text-slate-600">Чернетка не змінює поточну доставку. Етапи можна переглядати повторно; кожна зміна підтверджується окремо.</p>
    <nav className="magento-steps" aria-label="Етапи підготовки">{stages.map((label, index) => <button type="button" className="btn btn-outline btn-compact-md" key={label} aria-current={stage === index ? 'step' : undefined} onClick={() => setStage(index)}>{index + 1}. {label}</button>)}</nav>
    {error && <Notice>{error} <button className="btn btn-outline btn-compact-md" onClick={() => setReload((value) => value + 1)}>Повторити читання</button></Notice>}{!data && !error && <LoadingState />}
    {sourceChanged && <Notice>Активні відповідності змінилися. Оновіть стан інтеграції перед продовженням.
      <button className="btn btn-outline btn-compact-md" onClick={() => { setData(null); setRevisionId(''); setRepresentatives([]); setStage(0); setReload((value) => value + 1); onPublished(); }}>Повернутися до поточної публікації</button></Notice>}
    {data && !sourceChanged && <>
      <div className="card space-y-2 p-4"><p className="font-medium">{!revision ? 'Опублікованих відповідностей ще немає' : revision.state === 'draft' ? `Чернетка змін · ревізія ${revision.revision}` : revision.id === activePublication?.id ? `Переглядаємо активну версію ${revision.versionNumber}` : 'Переглядаємо історичну опубліковану версію'}</p>
        <p className="text-sm">Категорія: {category?.name || 'Не вибрано'}. {revision?.state === 'draft' ? 'Не впливає на поточну доставку.' : 'Опубліковані відповідності незмінні.'}</p></div>
      {stage === 0 && <section className="card space-y-4 p-5"><h3 className="font-semibold">Обсяг змін</h3>
        <label className="block text-sm">Що потрібно підготувати?<select className="input" value={intent} onChange={(event) => setIntent(event.target.value)}><option value="">Оберіть мету</option><option value="connect">Підключити категорію</option><option value="values">Додати категорії або значення</option><option value="mapping">Переглянути відповідності чи правила</option></select></label>
        <label className="block text-sm">Категорія Amber<select className="input" value={category?.code || ''} onChange={(event) => setCategoryCode(event.target.value)}>{data.categories.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <label className="block text-sm">Версія для перегляду<select className="input" value={revisionId} onChange={(event) => { ++sequence.current; setData(null); setRepresentatives([]); setRevisionId(event.target.value); }}><option value="">Поточна опублікована</option>{data.revisions.map((item) => <option key={item.id} value={item.id}>{item.state === 'draft' ? 'Чернетка' : item.id === activePublication?.id ? 'Активна версія' : 'Історична версія'} · {item.version_number || item.revision} · {new Date(item.observed_at).toLocaleString('uk-UA')}</option>)}</select></label>
        <Link className="text-sm underline" to="/admin#catalog-structure">Каталог та публікація SKU-схеми</Link>
        {activeRevision ? <MagentoBindingReview mode="successor" revision={activeRevision} currentPublishedId={activePublication.id} templateVersions={data.templateVersions} onChanged={successorChanged} /> : <EmptyState>Потрібна початкова опублікована інтеграція. Цей процес готує наступника чинної публікації.</EmptyState>}
        <button className="btn btn-primary" disabled={!intent || !category || revision?.state !== 'draft'} onClick={() => setStage(1)}>Перейти до ресурсів Magento</button>
      </section>}
      {stage === 1 && <div className="space-y-4"><h3 className="font-semibold">Підготувати відсутні ресурси</h3>
        <Notice tone="warning">Створення ресурсу змінює Magento, але не оновлює зафіксоване спостереження цієї чернетки. Після створення підготуйте нову чернетку зі свіжим спостереженням. Непубліковані рішення попередньої чернетки автоматично не переносяться.</Notice>
        <button className="btn btn-outline btn-compact-md" disabled={checking} onClick={onDiscover}>Перевірити Magento</button>
        {revision?.state === 'draft' ? <>
          <MagentoCategoryActions revision={revision} categoryCode={category?.code} observation={observation} onResourceChanged={resourceChanged} />
          <MagentoOptionActions mode="create" revision={revision} category={category} observation={observation} onResourceChanged={resourceChanged} />
        </> : <p>Спочатку підготуйте чернетку на етапі «Що змінюємо?».</p>}
        {resourcesChanged && <Notice tone="warning">Ресурси змінено. Перед новими підтвердженнями потрібна нова чернетка.</Notice>}
        {activeRevision && <section><h3 className="mb-3 font-semibold">Підготувати нову чернетку зі свіжим спостереженням</h3><MagentoBindingReview mode="successor" revision={activeRevision} currentPublishedId={activePublication.id} templateVersions={data.templateVersions} onChanged={successorChanged} /></section>}
      </div>}
      {stage === 2 && (resourcesChanged ? <Notice tone="warning">Підготуйте нову чернетку після створення ресурсів на попередньому етапі.</Notice> : revision ? <MagentoBindingReview mode="review" categoryCode={category?.code} revision={revision} currentPublishedId={activePublication?.id} onChanged={changeRevision} /> : <EmptyState>Спочатку виберіть відповідності.</EmptyState>)}
      {stage === 3 && (resourcesChanged ? <Notice tone="warning">Спочатку підготуйте нову чернетку зі свіжим спостереженням.</Notice> : revision && category && canPreview ? <>
        <MagentoProductChecks revision={revision} categoryCode={category.code} onRepresentative={(example) => setRepresentatives((previous) => [...previous.filter((item) => item.routeKey !== example.routeKey), { ...example, bindingId: revision.id, bindingRevision: revision.revision, publicationId: activePublication?.id }])} />
        {currentRepresentatives.length > 0 && <section className="card space-y-3 p-5"><h3 className="font-semibold">Збережені приклади CREATE: {currentRepresentatives.length}</h3><p className="text-sm">Кожний приклад зберігає власні перевірені поля. Перед публікацією сервер перевірить їх повторно.</p>{currentRepresentatives.map((item, index) => <p className="flex flex-wrap items-center gap-2 text-sm" key={item.routeKey}>Приклад {index + 1} · {data.categories.find((entry) => entry.code === item.group)?.name || item.group}<button className="btn btn-outline btn-compact-md" onClick={() => setRepresentatives((previous) => previous.filter((entry) => entry.routeKey !== item.routeKey))}>Прибрати приклад {index + 1}</button></p>)}</section>}
      </> : <Notice tone="warning">Для перевірки товарів потрібні права керування відповідностями та перегляду експорту.</Notice>)}
      {stage === 4 && (resourcesChanged ? <Notice tone="warning">Підготуйте нову чернетку зі свіжим спостереженням перед публікацією.</Notice> : revision ? <MagentoPublicationActions key={`${revision.id}:${revision.revision}:${JSON.stringify(currentRepresentatives)}`} revision={revision} currentPublishedId={activePublication?.id || null} representatives={currentRepresentatives} onPublished={(next) => { changeRevision(next); onPublished(next); }} /> : <EmptyState>Спочатку підготуйте чернетку.</EmptyState>)}
    </>}
  </div>;
}
