import { ArrowLeft, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { MagentoSyncStatus } from '../components/app/MagentoSyncStatus.jsx';
import { attentionProblemGroups, problemRepairUrl, problemTaskKey, problemTitle } from '../components/attention/sync-problem-presentation.js';
import IntegrationTaskQueue from '../components/attention/IntegrationTaskQueue.jsx';
import AttentionProblemDetail from '../components/attention/AttentionProblemDetail.jsx';
import { Button, CopyAction, EmptyState, LoadingState, Notice, PageHeader, Pagination } from '../components/ui/index.js';
import { api } from '../lib/api.js';
import '../components/attention/attention.css';

const PAGE_SIZE = 20;
const normalizedOffset = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const taskParams = problem => ({ task: problem ? problemTaskKey(problem) : null, cause: problem?.code || null,
  field: problem?.target || problem?.field || null, scope: problem?.scope || null });

export default function SyncProblemsPage() {
  const { permissions, principalLifetime } = useAuth();
  const canRead = permissions.includes('products.view') && principalLifetime?.valid !== false;
  const canDecode = permissions.includes('products.decode');
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const category = params.get('category') || '';
  const search = params.get('search') || '';
  const reason = params.get('reason') || '';
  const offset = normalizedOffset(params.get('offset'));
  const selectedId = normalizedOffset(params.get('problem')) || null;
  const groupId = params.get('group') || '';
  const settings = params.get('view') === 'settings' || Boolean(params.get('integrationTask'));
  const showGroups = !groupId && !selectedId;
  const productOffset = normalizedOffset(params.get('productOffset') ?? (!groupId ? params.get('offset') : null));
  const queryKey = `${category}:${search}:${reason}:${offset}:${groupId}:${productOffset}:${showGroups}`;
  const [result, setResult] = useState(null);
  const [detail, setDetail] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [polling, setPolling] = useState(false);
  const [saved, setSaved] = useState(null);
  const detailRef = useRef(null);
  const queueRef = useRef(null);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const setLocationState = useCallback((changes) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    setParams(next, { replace: true });
  }, [params, setParams]);

  useEffect(() => {
    if (!canRead || settings) return undefined;
    let live = true;
    let inFlight = false;
    let timer;
    let selectedState;
    const controller = new AbortController();
    const read = async () => {
      window.clearTimeout(timer);
      if (!live || inFlight) return;
      if (document.hidden) { timer = window.setTimeout(read, 15000); return; }
      inFlight = true;
      setPolling(true);
      await Promise.all([
        api.get(showGroups ? '/magento/problem-groups/page' : groupId ? `/magento/problem-groups/${encodeURIComponent(groupId)}/products` : '/magento/problems/page', { params: { category: category || undefined, search: search || undefined,
          reason: reason || undefined, limit: PAGE_SIZE, offset: showGroups ? offset : productOffset }, signal: controller.signal })
          .then(({ data }) => {
            if (!Array.isArray(data?.items) || !data.pageInfo) throw new Error('Incomplete problem evidence');
            if (live && principalLifetime?.valid !== false) setResult({ ...data, key: queryKey, principalLifetime, error: '' });
          }).catch((error) => {
            if (live && error?.name !== 'CanceledError') setResult((previous) => ({
              ...(previous?.key === queryKey && previous.principalLifetime === principalLifetime ? previous : {}),
              key: queryKey, principalLifetime, error: 'Не вдалося оновити проблеми доставки.' }));
          }),
        selectedId ? api.get(`/magento/problems/${selectedId}`, { signal: controller.signal })
          .then(({ data }) => {
            if (Number(data?.productId) !== selectedId || !Array.isArray(data.problems)) throw new Error('Wrong product evidence');
            if (live && principalLifetime?.valid !== false) {
              selectedState = data.state;
              setDetail({ item: data, id: selectedId, principalLifetime });
            }
          }).catch((error) => {
            if (live && error?.name !== 'CanceledError') setDetail(previous => ({
              ...(previous?.id === selectedId && previous.principalLifetime === principalLifetime && error?.response?.status !== 404 ? previous : {}),
              id: selectedId, principalLifetime,
              error: error?.response?.status === 404 ? 'Цей товар не знайдено.' : 'Не вдалося прочитати стан вибраного товару. Оновіть дані.' }));
          }) : Promise.resolve(),
      ]);
      inFlight = false;
      if (live) {
        setPolling(false);
        timer = window.setTimeout(read, ['pending', 'syncing'].includes(selectedState) ? 5000 : 15000);
      }
    };
    read();
    window.addEventListener('focus', read);
    return () => { live = false; controller.abort(); window.clearTimeout(timer); window.removeEventListener('focus', read); };
  }, [canRead, category, search, reason, offset, selectedId, queryKey, refresh, principalLifetime, groupId, productOffset, showGroups, settings]);

  const currentResult = canRead && result?.key === queryKey && result.principalLifetime === principalLifetime ? result : null;
  const currentDetail = canRead && detail?.id === selectedId && detail.principalLifetime === principalLifetime ? detail : null;
  const items = currentResult?.items;
  const selected = selectedId ? currentDetail?.item : null;
  const pageInfo = currentResult?.pageInfo || {};
  const categoryOptions = currentResult?.categories || [...new Map((items || []).filter(item => typeof item.category === 'string').map((item) => [item.category, { code: item.category, name: item.categoryName || item.category }])).values()];
  const hasFilters = category || search || reason;
  const productUrl = selected?.article ? `/products/open?article=${encodeURIComponent(selected.article)}` : null;
  const returnParams = new URLSearchParams(params);
  if (selected) returnParams.set('problem', String(selected.productId));
  const returnTo = `${['/attention', '/sync-problems'].includes(location.pathname) ? location.pathname : '/attention'}?${returnParams}`;
  const savedCurrent = Boolean(saved && selected && saved.productId === selected.productId && saved.principalLifetime === principalLifetime);
  const onSaved = (kind = 'product') => {
    setSaved({ productId: selected.productId, principalLifetime, kind });
    setDetail({ item: selected, id: selected.productId, principalLifetime });
    setLocationState({ problem: selected.productId }); reload();
  };
  const selectedGroupProblem = groupId && items?.find(item => Number(item.productId) === selectedId)?.groupProblem;
  const taskContext = params.get('task') ? { key: params.get('task') }
    : params.get('cause') ? { code: params.get('cause'), field: params.get('field') || '', scope: params.get('scope') || '' }
      : groupId && selectedId ? { key: selectedGroupProblem ? problemTaskKey(selectedGroupProblem) : '' } : null;
  const select = (id) => { setLocationState({ problem: id, ...taskParams(items?.find(item => Number(item.productId) === Number(id))?.groupProblem) }); window.setTimeout(() => detailRef.current?.focus(), 0); };
  const backToList = () => { setLocationState({ problem: null, ...taskParams(null) }); window.setTimeout(() => {
    const row = queueRef.current?.querySelector(`[data-product-id="${selectedId}"]`);
    (row || queueRef.current)?.focus();
  }, 0); };

  return <main className="app-page"><div className={`sync-problems-workspace ${selectedId ? 'has-selected-problem' : ''}`}>
    <PageHeader title="Потребує уваги"
      actions={canRead && <Button size="compactMd" onClick={reload} busy={polling}><RefreshCw size={15} aria-hidden="true" />Оновити</Button>} />
    {!canRead ? <Notice>Перегляд проблем синхронізації недоступний для вашого рівня доступу.</Notice> : <>
      <nav className="attention-tabs" aria-label="Задачі уваги">
        <Button size="compactMd" aria-current={!settings ? 'page' : undefined} onClick={() => setLocationState({ view: null, integrationTask: null })}>Товари</Button>
        <Button size="compactMd" aria-current={settings ? 'page' : undefined} onClick={() => setLocationState({ view: 'settings', problem: null, group: null })}>Налаштування</Button>
      </nav>
      {settings ? <>
        <IntegrationTaskQueue selectedTaskId={params.get('integrationTask')} refreshKey={refresh}
          onSelectTask={(id) => setLocationState({ integrationTask: id, problem: null })} />
      </> : <>
      {groupId && <Button size="compactMd" onClick={() => setLocationState({ group: null, problem: null, productOffset: null })}><ArrowLeft size={15} aria-hidden="true" />До причин</Button>}
      <form className="sync-problem-filters" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget);
        setLocationState({ search: String(form.get('search') || '').trim(), category: form.get('category'), reason: form.get('reason'), offset: null, productOffset: null, group: null, problem: null }); }}>
        <label className="sync-search">Артикул<span><Search size={16} aria-hidden="true" /><input key={search} className="input" name="search" defaultValue={search} placeholder="Знайти за артикулом" maxLength={120} /></span></label>
        <label>Категорія<select className="input" name="category" key={`${category}:${categoryOptions.map((item) => item.code).join(',')}`} defaultValue={category}><option value="">Усі категорії</option>
          {category && !categoryOptions.some((item) => item.code === category) && <option value={category}>{category}</option>}
          {categoryOptions.map((item) => <option key={item.code} value={item.code}>{item.name || item.code}</option>)}</select></label>
        <label>Причина<select className="input" name="reason" key={reason} defaultValue={reason}><option value="">Усі причини</option>
          <option value="product">Дані товару</option><option value="names">Узгодження назв</option><option value="integration">Правила та відповідності</option>
          <option value="connection">Підключення та доступ</option><option value="recovery">Перевірка попередньої операції</option></select></label>
        <Button type="submit" size="compactMd">Знайти</Button>
        {hasFilters && <Button size="compactMd" onClick={() => setLocationState({ search: null, category: null, reason: null, offset: null, group: null, productOffset: null, problem: null })}>Скинути</Button>}
      </form>
      {currentResult?.error && <Notice tone={items ? 'warning' : 'error'}>{currentResult.error}{items && ' Показано останні отримані дані.'}</Notice>}
      {!items && !currentResult?.error && <LoadingState label="Завантажуємо проблеми доставки…" />}
      {items && <p className="sync-problem-count" role="status">Товарів {groupId ? 'у цій групі' : 'у черзі'}: <strong>{showGroups ? currentResult?.summary?.productCount ?? 'невідомо' : Number.isInteger(pageInfo.total) ? pageInfo.total : 'невідомо'}</strong>{showGroups && <> · Причин: {pageInfo.total}</>}.</p>}
      {items?.length === 0 && !selectedId && !currentResult?.error && <EmptyState title={hasFilters ? 'За цими умовами товарів немає' : 'Зафіксованих проблем немає'}>{hasFilters ? 'Змініть пошук або фільтри.' : 'Amber не має поточних станів доставки, що потребують уваги.'}</EmptyState>}
      {showGroups && items?.length > 0 && <section className="attention-groups" aria-label="Причини проблем">
        <table><thead><tr><th>Що потрібно зробити</th><th>Товари</th><th>Наступна дія</th></tr></thead><tbody>
          {items.map(group => {
            const next = new URLSearchParams(params); next.set('group', group.id); next.delete('problem'); next.delete('productOffset');
            const returnToGroup = `${location.pathname}?${next}`;
            return <tr key={group.id}><th scope="row">{problemTitle(group.problem)}{group.sharedConfiguration && <small>Спільне налаштування для цих товарів</small>}</th>
              <td data-label="Товари"><button type="button" className="attention-text-action" onClick={() => setLocationState({ group: group.id, problem: null, productOffset: null })}>{group.productCount}</button></td>
              <td data-label="Наступна дія">{group.sharedConfiguration && permissions.includes('export_templates.view')
                ? <Link className="btn btn-outline btn-compact-md" to={problemRepairUrl(group.problem, group.exampleProduct, returnToGroup)}>Налаштувати відповідність</Link>
                : <Button size="compactMd" onClick={() => setLocationState({ group: group.id, problem: null, productOffset: null })}>Переглянути товари</Button>}</td></tr>;
          })}
        </tbody></table>
        <Pagination busy={polling} hasPrevious={pageInfo.hasPrevious} hasNext={pageInfo.hasNext}
          onPrevious={() => setLocationState({ offset: Math.max(0, offset - PAGE_SIZE) })} onNext={() => setLocationState({ offset: offset + PAGE_SIZE })}
          summary={`${offset + 1}–${Math.min(offset + items.length, pageInfo.total)} із ${pageInfo.total} причин`} />
      </section>}
      {!showGroups && (items?.length > 0 || selectedId) && <section className={`sync-problem-master-detail ${selectedId ? 'has-selection' : ''}`}>
        <aside ref={queueRef} tabIndex={-1} className="sync-problem-queue" aria-label="Черга проблем доставки">
          {items?.length === 0 && !currentResult?.error && <EmptyState title={hasFilters ? 'За цими умовами товарів немає' : 'Зафіксованих проблем немає'}>{hasFilters ? 'Змініть пошук або фільтри.' : 'Amber не має поточних станів доставки, що потребують уваги.'}</EmptyState>}
          {items?.map((item) => <button key={item.productId} data-product-id={item.productId} type="button" className={`sync-problem-queue-item ${Number(selected?.productId) === Number(item.productId) ? 'is-selected' : ''}`}
            aria-pressed={Number(selected?.productId) === Number(item.productId)} onClick={() => select(item.productId)}>
            <strong>{item.article || 'Артикул недоступний'}</strong><small>{item.categoryName || item.category}</small>
            <span>{problemTitle(item.groupProblem || attentionProblemGroups(item.problems)[0]?.problem)}</span>
          </button>)}
          <Pagination busy={polling} hasPrevious={pageInfo.hasPrevious} hasNext={pageInfo.hasNext}
            onPrevious={() => setLocationState({ productOffset: Math.max(0, productOffset - PAGE_SIZE), ...(groupId ? { problem: null, ...taskParams(null) } : {}) })}
            onNext={() => setLocationState({ productOffset: productOffset + PAGE_SIZE, ...(groupId ? { problem: null, ...taskParams(null) } : {}) })}
            summary={pageInfo.total > 0 ? `${productOffset + 1}–${Math.min(productOffset + (items?.length || 0), pageInfo.total)} із ${pageInfo.total}` : undefined} />
        </aside>
        <article ref={detailRef} tabIndex={-1} className="sync-problem-detail" aria-label="Деталі проблеми">
          {selectedId && <Button className="sync-back" size="compactMd" onClick={backToList}><ArrowLeft size={15} aria-hidden="true" />До списку товарів</Button>}
          {selectedId && !currentDetail && <LoadingState label="Читаємо вибраний товар…" />}
          {currentDetail?.error && <Notice tone="error">{currentDetail.error}</Notice>}
          {selected && <>
            <header><div><p className="eyebrow">Артикул · {selected.categoryName || selected.category}</p><h2>{selected.article || 'Артикул недоступний'} {selected.article && <CopyAction value={selected.article} label="Копіювати артикул" />}</h2></div>
              <MagentoSyncStatus status={{ state: selected.state || 'needs_attention', confirmedAt: selected.confirmedAt }} /></header>
            {savedCurrent && <Notice tone="success">{saved.kind === 'recovery'
              ? 'Результат перевірки доставки збережено в Amber. Поточний стан Magento показано окремо.'
              : saved.kind === 'first_sync_fields' ? 'Рішення для поля збережено. Результат доставки перевіряється окремо.'
                : 'Дані виправлено в Amber. Результат доставки показано окремо у стані Magento.'}</Notice>}
            {selected.state && selected.state !== 'needs_attention' && <Notice tone={selected.state === 'synced' ? 'success' : 'info'}>
              {selected.state === 'synced' ? 'Magento підтвердив синхронізацію поточного стану товару.'
                : ['pending', 'syncing'].includes(selected.state) ? 'Поточна зміна очікує завершення доставки. Ця сторінка оновить стан автоматично.'
                  : 'Поточний стан не містить зафіксованої проблеми. Це саме по собі не підтверджує доставку.'}</Notice>}
            {(!selected.state || selected.state === 'needs_attention') && <AttentionProblemDetail key={JSON.stringify([selected.productId, selectedId])} product={selected} productUrl={productUrl} returnTo={returnTo} onSaved={onSaved}
              taskContext={taskContext}
              onSelectTask={problem => setLocationState(taskParams(problem))}
              onRepairCharacteristics={canDecode && productUrl && permissions.includes('products.recount') ? () => navigate(`${productUrl}&action=recount&returnTo=${encodeURIComponent(returnTo)}`) : undefined} />}
            {selected.state && selected.state !== 'needs_attention' && selected.problems.length > 0 && <details className="sync-history-problems"><summary>Попередні причини цього товару ({selected.problems.length})</summary><p>Це збережена діагностика попередньої спроби. Поточний стан доставки показано вище.</p><ul>{attentionProblemGroups(selected.problems).map(({ key, problem }) => <li key={key}>{problemTitle(problem)}</li>)}</ul></details>}
            <footer>{selected.state === 'synced' && items?.some(item => item.productId !== selected.productId) && <Button size="compactMd" onClick={() => select(items.find(item => item.productId !== selected.productId).productId)}>До наступного товару</Button>}<CopyAction compact buttonLabel="Копіювати опис проблеми" label="Копіювати опис проблеми" value={`${selected.article || ''}\n${attentionProblemGroups(selected.problems).map(({ problem }) => problemTitle(problem)).join('\n')}\n${window.location.origin}/attention?problem=${selected.productId}`} />
              {permissions.includes('history.view') && selected.article && <Link className="btn btn-outline btn-compact-md" to={`/products/history?sku=${encodeURIComponent(selected.article)}`}>Історія товару</Link>}
              {canDecode && productUrl && <Link className="btn btn-outline btn-compact-md" to={productUrl}>Відкрити товар</Link>}</footer>
          </>}
          {!selected && !selectedId && items?.length > 0 && <p>Виберіть товар у черзі.</p>}
        </article>
      </section>}
      </>}
    </>}
  </div></main>;
}
