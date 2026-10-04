import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/auth-context.js';
import { api } from '../../lib/api.js';
import { EmptyState, LoadingState, Notice } from '../app/UiPrimitives.jsx';
import MagentoBindingReview from './MagentoBindingReview.jsx';
import MagentoCategoryActions from './MagentoCategoryActions.jsx';
import MagentoOptionActions from './MagentoOptionActions.jsx';
import MagentoPublicationActions from './MagentoPublicationActions.jsx';
import MagentoProductChecks from './MagentoProductChecks.jsx';
import MagentoDetails from './MagentoDetails.jsx';
import { repairContext, withRepairContext } from '../../lib/magento-repair-context.js';
import MagentoAttributeActions from './MagentoAttributeActions.jsx';
import MagentoStructureResult from './MagentoStructureResult.jsx';

const stages = ['Початок', 'Дані Magento', 'Підключення', 'Перевірка товарів', 'Застосування'];
const goals = [
  { value: 'subcategory', title: 'Додати підкатегорію магазину', text: 'Розміщення товарів у потрібному розділі магазину.' },
  { value: 'attribute', title: 'Додати характеристику', text: 'Характеристика товару, поле Magento та його значення.' },
  { value: 'option', title: 'Додати варіант характеристики', text: 'Перевірити наявне значення або створити нове та підключити його.' },
  { value: 'category', title: 'Налаштувати нову категорію', text: 'Характеристики, ціни та розміщення товарів у магазині.' },
  { value: 'rules', title: 'Змінити правило поля', text: 'Назва, текст або значення, яке Amber передає в Magento.' },
  { value: 'mapping', title: 'Пов’язати наявні характеристики', text: 'Зіставити поле або значення Amber з уже наявним у Magento.' },
  { value: 'values', title: 'Додати значення або категорію Magento', text: 'Створити відсутній ресурс, перевірити його та підтвердити відповідність.' },
  { value: 'connect', title: 'Підключити категорію Amber', text: 'Підготувати правила, ресурси Magento та перевірити новий товар.' },
];
export default function MagentoPreparationWorkspace({ activePublication, observation, onPublished, onDiscover, checking, checkError }) {
  const navigate = useNavigate(); const { permissions } = useAuth(); const [params, setParams] = useSearchParams();
  const revisionId = params.get('draft') || ''; const categoryCode = params.get('category') || '';
  const context = repairContext(params);
  function queryChange(changes) { setParams((previous) => { const next = new URLSearchParams(previous); for (const [key, value] of Object.entries(changes)) { if (value == null || value === '') next.delete(key); else next.set(key, String(value)); } return next; }, { replace: true }); }
  const setRevisionId = (draft) => queryChange({ draft });
  const setCategoryCode = (category) => { setRepresentatives([]); queryChange({ category, field: null, question: null, value: null, path: null, productId: null }); };
  const setStage = (step) => queryChange({ step });
  const setIntent = (intent) => queryChange({ intent, step: 0 });
  const [loaded, setData] = useState(null);
  const readKey = `${revisionId}:${activePublication?.id || ''}`;
  const data = loaded?.key === readKey ? loaded.value : null; const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const intent = goals.some((goal) => goal.value === params.get('intent')) ? params.get('intent') : '';
  const stage = [0, 1, 2, 3, 4, 5].includes(Number(params.get('step'))) ? Number(params.get('step')) : 0;
  const [representatives, setRepresentatives] = useState([]); const [publishedResult, setPublishedResult] = useState(false);
  const [draftsNeedingObservation, setDraftsNeedingObservation] = useState(() => new Set()); const sequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const ticket = ++sequence.current;
    api.get('/admin/magento-integration', { params: revisionId ? { bindingRevisionId: revisionId } : {}, signal: controller.signal })
      .then(({ data: result }) => { if (!controller.signal.aborted && ticket === sequence.current) { setData({ key: readKey, value: result }); setError(''); } })
      .catch((cause) => { if (!controller.signal.aborted && ticket === sequence.current) setError(cause.response?.data?.error || 'Не вдалося прочитати контекст підготовки.'); });
    return () => { controller.abort(); };
  }, [revisionId, readKey, reload]);
  function changeRevision(revision) {
    ++sequence.current; setData(null); setRepresentatives([]); setRevisionId(revision.id); setReload((value) => value + 1); setError('');
  }
  const revision = data?.revision;
  const resourcesChanged = draftsNeedingObservation.has(revision?.id) || params.get('refresh') === revision?.id;
  const category = categoryCode ? data?.categories.find((item) => item.code === categoryCode) : data?.categories[0];
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
    setRepresentatives([]); queryChange({ refresh: revision.id });
  };
  const successorChanged = (next) => { ++sequence.current; setData(null); setRepresentatives([]); setError(''); queryChange({ draft: next.id, step: resourcesChanged ? 2 : intent === 'mapping' ? 2 : intent === 'rules' ? (params.get('templateVersion') ? 2 : 5) : intent === 'attribute' && params.get('templateVersion') ? 2 : 1, refresh: null }); setReload((value) => value + 1); };
  const stageIds = intent === 'mapping' ? [0, 2, 3, 4] : intent === 'rules' ? [0, 5, 2, 3, 4] : [0, 1, 2, 3, 4];
  const selectedGoal = goals.find((goal) => goal.value === intent);
  const categoryQuery = encodeURIComponent(category?.code || '');
  const taskPath = `/admin/magento/prepare?${params}`;
  const catalogLink = (action) => `/admin/catalog?${new URLSearchParams({ category: category?.code || '', ...(context.question ? { question: context.question } : {}), ...(action ? { action } : {}), returnTo: taskPath })}`;
  const rulesPath = revision?.templateId ? withRepairContext(`/admin/magento/rules/${encodeURIComponent(revision.templateId)}`, context, { version: revision.templateVersionId, intent: intent || 'rules', category: category?.code, ...(intent === 'subcategory' ? { field: 'categories' } : {}) }) : null;
  const field = params.get('field') || undefined;
  const returnPath = context.returnTo || (context.productId ? `/attention?problem=${encodeURIComponent(context.productId)}` : `/admin/magento/categories/${categoryQuery}`);
  return <div className="space-y-5">
    <Link className="text-sm underline" to={returnPath}>{context.productId ? 'Повернутися до товару' : 'До категорії'}</Link>
    <h2 className="text-xl font-semibold">{selectedGoal?.title || 'Підготувати зміни інтеграції'}</h2>
    <p className="text-sm text-slate-600">Чернетка не змінює поточну доставку. Етапи можна переглядати повторно; кожна зміна підтверджується окремо.</p>
    {context.path && <p className="font-medium">Розміщення: {context.path.replaceAll('/', ' → ')}</p>}
    {context.question && <p className="text-sm">{category?.values?.find((item) => item.questionKey === context.question)?.questionLabel || 'Обрана характеристика'}{context.value ? `: ${category?.values?.find((item) => item.questionKey === context.question && String(item.valueId) === context.value)?.label || context.value}` : ''}</p>}
    {publishedResult?.id === revision?.id && publishedResult?.category === category?.code && publishedResult?.intent === intent && <Notice tone="success"><p>Налаштування опубліковано. Результат передавання товарів перевіряється окремо.</p><Link className="underline" to={returnPath}>{context.productId ? 'Перевірити стан цього товару' : 'Переглянути категорію'}</Link></Notice>}
    <nav className="magento-steps" aria-label="Етапи підготовки">{stageIds.map((id, index) => <button type="button" className="btn btn-outline btn-compact-md" key={id} aria-current={stage === id ? 'step' : undefined} onClick={() => setStage(id)}>{index + 1}. {id === 5 ? 'Правила передачі' : stages[id]}</button>)}</nav>
    {error && <Notice>{error} <button className="btn btn-outline btn-compact-md" onClick={() => setReload((value) => value + 1)}>Повторити читання</button></Notice>}{!data && !error && <LoadingState />}
    {sourceChanged && <Notice>Активні відповідності змінилися. Оновіть стан інтеграції перед продовженням.
      <button className="btn btn-outline btn-compact-md" onClick={() => { setData(null); queryChange({ draft: null, step: 0 }); setRepresentatives([]); setReload((value) => value + 1); onPublished(); }}>Повернутися до поточної публікації</button></Notice>}
    {data && !sourceChanged && categoryCode && !category && <Notice tone="warning">Категорію цієї задачі не знайдено. Поверніться до товару або оберіть категорію заново. Налаштування іншої категорії не підставлено.</Notice>}
    {data && !sourceChanged && (!categoryCode || category) && <>
      <div className="card space-y-2 p-4"><p className="font-medium">{!revision ? 'Опублікованих відповідностей ще немає' : revision.state === 'draft' ? `Чернетка змін · ревізія ${revision.revision}` : revision.id === activePublication?.id ? `Переглядаємо активну версію ${revision.versionNumber}` : 'Переглядаємо історичну опубліковану версію'}</p>
        <p className="text-sm">Категорія: {category?.name || 'Не вибрано'}. {revision?.state === 'draft' ? 'Не впливає на поточну доставку.' : 'Опубліковані відповідності незмінні.'}</p></div>
      {stage === 0 && <section className="card space-y-4 p-5"><h3 className="font-semibold">Обсяг змін</h3>
        <details open={!intent}><summary>Змінити задачу</summary><div className="magento-goal-grid" role="group" aria-label="Що потрібно підготувати?">{goals.map((goal) => <button type="button" key={goal.value} aria-pressed={intent === goal.value} onClick={() => setIntent(goal.value)}><strong>{goal.title}</strong><span>{goal.text}</span></button>)}</div></details>
        <label className="block text-sm">Категорія товарів<select className="input" value={category?.code || ''} onChange={(event) => setCategoryCode(event.target.value)}>{data.categories.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
        <details><summary>Відкрити збережену чернетку або історичну версію</summary><label className="block text-sm">Версія для перегляду<select className="input" value={revisionId} onChange={(event) => { ++sequence.current; setData(null); setRepresentatives([]); setRevisionId(event.target.value); }}><option value="">Поточна опублікована</option>{data.revisions.map((item) => <option key={item.id} value={item.id}>{item.state === 'draft' ? 'Чернетка' : item.id === activePublication?.id ? 'Активна версія' : 'Історична версія'} · {item.version_number || item.revision} · {new Date(item.observed_at).toLocaleString('uk-UA')}</option>)}</select></label></details>
        {permissions.includes('catalog.view') && <Link className="text-sm underline" to={catalogLink()}>Каталог цієї категорії: характеристики, значення та SKU-схема</Link>}
        {intent === 'rules' && activePublication?.templateId && <Link className="btn btn-outline" to={withRepairContext(`/admin/magento/rules/${encodeURIComponent(activePublication.templateId)}`, context, { version: activePublication.templateVersionId, category: category?.code })}>Відкрити поточні правила категорії</Link>}
        {activeRevision ? <MagentoBindingReview repairContext={context} taskIntent={intent} guided mode="successor" categoryCode={category?.code} revision={activeRevision} currentPublishedId={activePublication.id} templateVersions={data.templateVersions} initialTemplateVersionId={params.get('templateVersion') || activePublication.templateVersionId} onChanged={successorChanged} /> : <EmptyState>Потрібна початкова опублікована інтеграція. Цей процес готує наступника чинної публікації.</EmptyState>}
        <button className="btn btn-primary" disabled={!intent || !category || revision?.state !== 'draft'} onClick={() => setStage(stageIds[1])}>Продовжити: {stageIds[1] === 5 ? 'правила передачі' : stageIds[1] === 2 ? 'підключення' : 'дані Magento'}</button>
      </section>}
      {stage === 5 && <section className="card space-y-3 p-5"><h3 className="font-semibold">Правила передачі полів</h3><p>Змініть правило у чернетці, перевірте приклади й зафіксуйте версію. Після повернення підготуйте налаштування Magento саме з цією версією.</p>{revision?.templateId && <Link className="btn btn-primary" to={rulesPath}>Переглянути правила цієї підготовки</Link>}<button className="btn btn-outline" onClick={() => setStage(2)}>Перейти до відповідностей</button></section>}
      {stage === 1 && <div className="space-y-4"><h3 className="font-semibold">{intent === 'subcategory' ? 'Розміщення в магазині' : intent === 'attribute' ? 'Характеристика та атрибут Magento' : intent === 'option' ? 'Варіант характеристики' : 'Категорії та характеристики'}</h3>
        {permissions.includes('catalog.view') && ['attribute', 'option', 'category', 'connect'].includes(intent) && <section className="space-y-2"><h4 className="font-medium">Дані товарів в Amber</h4><Link className="underline text-sm" to={catalogLink(intent === 'option' ? 'new-option' : intent === 'attribute' ? 'new-question' : undefined)}>{intent === 'option' ? 'Додати варіант характеристики' : intent === 'attribute' ? 'Додати характеристику товару' : 'Переглянути характеристики та схему SKU'}</Link><p className="text-sm text-slate-600">Для нових значень, що входять до внутрішнього SKU, опублікуйте схему в каталозі перед підключенням.</p></section>}
        {intent === 'attribute' && revision && <MagentoAttributeActions revision={revision} categoryCode={category?.code} initialAttributeCode={field} onResourceChanged={resourceChanged} onReady={(action) => { if (rulesPath) navigate(withRepairContext(rulesPath, context, { field: action.attributeCode, category: category?.code })); }} />}
        <button className="btn btn-outline btn-compact-md" disabled={checking} onClick={onDiscover}>Перевірити структуру</button>
        {checking && <LoadingState compact label="Перевіряємо структуру…" />}
        {checkError && <Notice tone="warning">{checkError}</Notice>}
        {!checking && !checkError && <MagentoStructureResult comparison={observation?.comparison} activeId={activePublication?.id} />}
        {revision?.state === 'draft' ? <>
          {intent !== 'option' && intent !== 'attribute' && <MagentoCategoryActions revision={revision} categoryCode={category?.code} observation={observation} onResourceChanged={resourceChanged} />}
          {!['subcategory', 'attribute'].includes(intent) && <MagentoOptionActions mode="create" revision={revision} category={category} observation={observation} onResourceChanged={resourceChanged} initialQuestionKey={context.question} initialValueId={context.value} initialAttributeCode={field} onExisting={() => setStage(2)} />}
        </> : <p>Почніть зміну налаштувань на першому кроці.</p>}
        {rulesPath && intent !== 'attribute' && <Link className="btn btn-outline" to={rulesPath}>{intent === 'subcategory' ? 'Вибрати розділ і товари для підкатегорії' : 'Налаштувати передачу цієї характеристики'}</Link>}
        {resourcesChanged && <Notice tone="success">Зміну в Magento підтверджено. Залишилося перевірити підключення та застосувати налаштування.</Notice>}
        {activeRevision && (resourcesChanged || revision?.state !== 'draft') && <MagentoBindingReview repairContext={context} taskIntent={intent} guided refreshing mode="successor" categoryCode={category?.code} revision={activeRevision} currentPublishedId={activePublication.id} templateVersions={data.templateVersions} initialTemplateVersionId={revision?.templateVersionId || activePublication.templateVersionId} onChanged={successorChanged} />}
        {revision?.state === 'draft' && !resourcesChanged && <button className="btn btn-primary" onClick={() => setStage(2)}>Перевірити підключення</button>}
        <MagentoDetails summary="Як зберігаються підготовлені зміни">{() => <p>Створення в Magento не оновлює зафіксоване спостереження. Непубліковані рішення попередньої чернетки автоматично не переносяться. Після перевірки створюється нова підготовка від чинних налаштувань; попередні дії залишаються в історії.</p>}</MagentoDetails>
      </div>}
      {stage === 2 && (resourcesChanged ? <Notice tone="warning">Підготуйте нову чернетку після створення ресурсів на попередньому етапі.</Notice> : revision ? <MagentoBindingReview repairContext={context} taskIntent={intent} mode="review" categoryCode={category?.code} field={field} revision={revision} currentPublishedId={activePublication?.id} onChanged={changeRevision} /> : <EmptyState>Спочатку виберіть відповідності.</EmptyState>)}
      {stage === 3 && (resourcesChanged ? <Notice tone="warning">Спочатку підготуйте нову чернетку зі свіжим спостереженням.</Notice> : revision && category && canPreview ? <>
        <MagentoProductChecks revision={revision} categoryCode={category.code} initialProductId={context.productId} onRepresentative={(example) => setRepresentatives((previous) => [...previous.filter((item) => item.routeKey !== example.routeKey), { ...example, bindingId: revision.id, bindingRevision: revision.revision, publicationId: activePublication?.id }])} />
        {currentRepresentatives.length > 0 && <section className="card space-y-3 p-5"><h3 className="font-semibold">Збережені приклади нових товарів: {currentRepresentatives.length}</h3><p className="text-sm">Кожний приклад зберігає власні перевірені поля. Перед публікацією сервер перевірить їх повторно.</p>{currentRepresentatives.map((item, index) => <p className="flex flex-wrap items-center gap-2 text-sm" key={item.routeKey}>Приклад {index + 1} · {data.categories.find((entry) => entry.code === item.group)?.name || item.group}<button className="btn btn-outline btn-compact-md" onClick={() => setRepresentatives((previous) => previous.filter((entry) => entry.routeKey !== item.routeKey))}>Прибрати приклад {index + 1}</button></p>)}</section>}
      </> : <Notice tone="warning">Для перевірки товарів потрібні права керування відповідностями та перегляду експорту.</Notice>)}
      {revision?.state === 'draft' && !resourcesChanged && [2, 3].includes(stage) && <button className="btn btn-primary" onClick={() => setStage(stage + 1)}>{stage === 2 ? 'Перевірити товар із цими налаштуваннями' : 'Переглянути зміни перед застосуванням'}</button>}
      {stage === 4 && (resourcesChanged ? <Notice tone="warning">Підготуйте нову чернетку зі свіжим спостереженням перед публікацією.</Notice> : revision ? <MagentoPublicationActions key={`${revision.id}:${revision.revision}:${JSON.stringify(currentRepresentatives)}`} revision={revision} currentPublishedId={activePublication?.id || null} representatives={currentRepresentatives} onPublished={(next) => { setPublishedResult({ id: next.id, category: category?.code, intent }); changeRevision(next); onPublished(next); }} /> : <EmptyState>Спочатку підготуйте чернетку.</EmptyState>)}
    </>}
  </div>;
}
